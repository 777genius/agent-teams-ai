#include <errno.h>
#include <libproc.h>
#include <mach/mach.h>
#include <math.h>
#include <node_api.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <unistd.h>

/* Private packaged N-API adapter. Never receives renderer paths or ambient PID selectors.
 * Original root comes only from synchronous CapturedProcess.launch admission.
 * Admission proves same-session or a complete live audited parent chain, never tree containment. */
#define TRY(call) do { if ((call) != napi_ok) return fail(env, "napi", EIO); } while (0)
static napi_value fail(napi_env env, const char *stage, int code) {
  char message[128];
  snprintf(message, sizeof(message), "%s:%d", stage, code);
  napi_throw_error(env, "registered-process-unavailable", message);
  return NULL;
}
static int text_sysctl(const char *key, char *out, size_t cap) {
  size_t size = cap;
  if (sysctlbyname(key, out, &size, NULL, 0)) return errno;
  return size > 1 && size <= cap && out[size - 1] == 0 ? 0 : EINVAL;
}
static int token_of(pid_t pid, audit_token_t *out) {
  mach_port_t port = MACH_PORT_NULL;
  kern_return_t code = task_name_for_pid(mach_task_self(), pid, &port);
  if (code != KERN_SUCCESS || port == MACH_PORT_NULL) return EACCES;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  code = task_info(port, TASK_AUDIT_TOKEN, (task_info_t)out, &count);
  kern_return_t released = mach_port_deallocate(mach_task_self(), port);
  return code == KERN_SUCCESS && released == KERN_SUCCESS &&
    count == TASK_AUDIT_TOKEN_COUNT && out->val[5] == (uint32_t)pid ? 0 : EACCES;
}
static int equal_token(const audit_token_t *a, const audit_token_t *b) {
  return memcmp(a, b, sizeof(*a)) == 0;
}
static int parse_pid(napi_env env, napi_value value, pid_t *pid) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok || !isfinite(number) || number < 2 ||
      number > INT32_MAX || number != (double)(int32_t)number) return EINVAL;
  *pid = (pid_t)number;
  return 0;
}
static int parse_token(napi_env env, napi_value value, audit_token_t *token) {
  uint32_t length;
  if (napi_get_array_length(env, value, &length) != napi_ok || length != 8) return EINVAL;
  for (uint32_t i = 0; i < 8; i++) {
    napi_value item;
    double number;
    if (napi_get_element(env, value, i, &item) != napi_ok ||
        napi_get_value_double(env, item, &number) != napi_ok || !isfinite(number) || number < 0 ||
        number > UINT32_MAX || number != (double)(uint32_t)number) return EINVAL;
    token->val[i] = (uint32_t)number;
  }
  return token->val[5] > 1 && token->val[5] <= INT32_MAX ? 0 : EINVAL;
}
static int matches_boot(napi_env env, napi_value value) {
  char expected[128] = {0}, actual[128] = {0};
  size_t length;
  return napi_get_value_string_utf8(env, value, expected, sizeof(expected), &length) == napi_ok &&
    length == 36 && text_sysctl("kern.bootsessionuuid", actual, sizeof(actual)) == 0 &&
    strcmp(expected, actual) == 0;
}
static napi_value snapshot(napi_env env, const audit_token_t *token, pid_t sid) {
  char boot[128] = {0}, build[128] = {0};
  int code = text_sysctl("kern.bootsessionuuid", boot, sizeof(boot));
  if (code) return fail(env, "boot", code);
  code = text_sysctl("kern.osversion", build, sizeof(build));
  if (code) return fail(env, "os-build", code);
  napi_value result, value, array;
  TRY(napi_create_object(env, &result));
  TRY(napi_create_array_with_length(env, 8, &array));
  for (uint32_t i = 0; i < 8; i++) {
    TRY(napi_create_uint32(env, token->val[i], &value));
    TRY(napi_set_element(env, array, i, value));
  }
  TRY(napi_set_named_property(env, result, "auditToken", array));
  TRY(napi_create_int32(env, sid, &value));
  TRY(napi_set_named_property(env, result, "sessionId", value));
  TRY(napi_create_string_utf8(env, boot, NAPI_AUTO_LENGTH, &value));
  TRY(napi_set_named_property(env, result, "bootId", value));
  TRY(napi_create_string_utf8(env, build, NAPI_AUTO_LENGTH, &value));
  TRY(napi_set_named_property(env, result, "osBuild", value));
  return result;
}
static napi_value capture_root(napi_env env, napi_callback_info info) {
  napi_value args[1]; size_t count = 1; pid_t pid;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 1 || parse_pid(env, args[0], &pid)) return fail(env, "arguments", EINVAL);
  audit_token_t before, after;
  if (token_of(pid, &before)) return fail(env, "root-token", EACCES);
  if (getsid(pid) != pid || getpgid(pid) != pid) return fail(env, "isolated-root", EPERM);
  if (token_of(pid, &after) || !equal_token(&before, &after)) return fail(env, "root-changed", ESRCH);
  return snapshot(env, &before, pid);
}
/* Registration-only proof. Birth is kernel monotonic time, never a wall-clock/PID heuristic.
 * Every original vertex must survive the reverse pass with identical identity and parent edge. */
#define MAX_LIVE_ANCESTRY 16
struct live_vertex {
  audit_token_t token;
  uint64_t birth;
  pid_t pid, ppid, sid;
};
static int read_vertex(pid_t pid, struct live_vertex *out) {
  audit_token_t after;
  struct proc_bsdinfo bsd;
  struct rusage_info_v0 usage;
  if (pid <= 1 || token_of(pid, &out->token)) return EACCES;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd)) != (int)sizeof(bsd) ||
      bsd.pbi_pid != (uint32_t)pid || (bsd.pbi_flags & (PROC_FLAG_TRACED | PROC_FLAG_INEXIT)) ||
      proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&usage) != 0 ||
      usage.ri_proc_start_abstime == 0 || usage.ri_proc_exit_abstime != 0)
    return ESRCH;
  out->pid = pid; out->ppid = (pid_t)bsd.pbi_ppid;
  out->sid = getsid(pid); out->birth = usage.ri_proc_start_abstime;
  if (out->sid <= 1 || token_of(pid, &after) || !equal_token(&out->token, &after)) return ESRCH;
  return 0;
}
static int live_ancestry(const audit_token_t *root, const audit_token_t *target, pid_t sid) {
  struct live_vertex path[MAX_LIVE_ANCESTRY], check;
  size_t length = 0;
  pid_t pid = (pid_t)target->val[5], root_pid = (pid_t)root->val[5];
  for (; length < MAX_LIVE_ANCESTRY; length++) {
    for (size_t i = 0; i < length; i++) if (path[i].pid == pid) return ELOOP;
    if (read_vertex(pid, &path[length])) return ESRCH;
    if (length == 0 && (!equal_token(target, &path[0].token) || path[0].sid != sid)) return ESRCH;
    if (length > 0 && path[length].birth >= path[length - 1].birth) return EPERM;
    if (pid == root_pid) {
      if (!equal_token(root, &path[length].token) || path[length].sid != root_pid ||
          getpgid(root_pid) != root_pid) return ESRCH;
      length++;
      break;
    }
    if (path[length].ppid <= 1) return EPERM;
    pid = path[length].ppid;
  }
  if (length == 0 || path[length - 1].pid != root_pid) return EPERM;
  for (size_t i = length; i-- > 0;) {
    if (read_vertex(path[i].pid, &check) || !equal_token(&check.token, &path[i].token) ||
        check.birth != path[i].birth || check.ppid != path[i].ppid || check.sid != path[i].sid)
      return ESRCH;
  }
  return 0;
}
static napi_value capture_descendant(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3; pid_t target;
  audit_token_t root, before, after, root_now;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 3 || !matches_boot(env, args[0]) || parse_token(env, args[1], &root) ||
      parse_pid(env, args[2], &target)) return fail(env, "arguments", EINVAL);
  pid_t root_pid = (pid_t)root.val[5];
  if (target == root_pid || target == getpid() || target == getppid()) return fail(env, "target-is-root", EPERM);
  if (token_of(root_pid, &root_now) || !equal_token(&root, &root_now) ||
      getsid(root_pid) != root_pid || getpgid(root_pid) != root_pid)
    return fail(env, "original-root-unavailable", ESRCH);
  if (token_of(target, &before)) return fail(env, "target-token", EACCES);
  pid_t target_sid = getsid(target);
  int ancestry = target_sid != root_pid;
  if (ancestry && (target_sid <= 1 || target == target_sid || live_ancestry(&root, &before, target_sid)))
    return fail(env, "unproven-live-ancestry", EPERM);
  if (token_of(target, &after) || !equal_token(&before, &after) || getsid(target) != target_sid)
    return fail(env, "target-changed", ESRCH);
  /* Both admission paths finish against the same supplied original root; never select a replacement. */
  if (token_of(root_pid, &root_now) || !equal_token(&root, &root_now) ||
      getsid(root_pid) != root_pid || getpgid(root_pid) != root_pid)
    return fail(env, "original-root-changed", ESRCH);
  napi_value result = snapshot(env, &before, target_sid);
  if (result == NULL) return NULL;
  if (ancestry) {
    napi_value admission;
    TRY(napi_create_string_utf8(env, "live-ancestry-v1", NAPI_AUTO_LENGTH, &admission));
    TRY(napi_set_named_property(env, result, "admission", admission));
  }
  return result;
}
static napi_value signal_original(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3; pid_t sid;
  audit_token_t original, current;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 3 || !matches_boot(env, args[0]) || parse_token(env, args[1], &original) ||
      parse_pid(env, args[2], &sid)) return fail(env, "arguments", EINVAL);
  pid_t pid = (pid_t)original.val[5];
  if (pid == getpid() || pid == getppid() || pid == sid) return fail(env, "unsafe-target", EPERM);
  if (token_of(pid, &current) || !equal_token(&original, &current) || getsid(pid) != sid)
    return fail(env, "original-target-changed", ESRCH);
  /* Caller persisted requested marker before entry. Failure after this line is unknown. */
  int code = proc_signal_with_audittoken(&original, SIGTERM);
  napi_value result;
  TRY(napi_create_int32(env, code, &result));
  return result; /* code0 means signal accepted, never proof of exit. */
}
static napi_value observe_original(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3; pid_t sid;
  audit_token_t original, current;
  const char *state = "unknown";
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 3 || parse_token(env, args[1], &original) || parse_pid(env, args[2], &sid))
    return fail(env, "arguments", EINVAL);
  if (!matches_boot(env, args[0])) state = "stale";
  else {
    pid_t pid = (pid_t)original.val[5];
    struct proc_bsdinfo info;
    errno = 0;
    int length = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (length <= 0 && errno == ESRCH) state = "absent";
    else if (length == (int)sizeof(info) && token_of(pid, &current) == 0) {
      if (!equal_token(&original, &current)) state = "stale";
      else if (getsid(pid) != sid) state = "unknown";
      else {
        audit_token_t after;
        state = token_of(pid, &after) == 0 && equal_token(&current, &after) && getsid(pid) == sid
          ? "same-live" : "unknown";
      }
    }
  }
  napi_value result;
  TRY(napi_create_string_utf8(env, state, NAPI_AUTO_LENGTH, &result));
  return result;
}
static napi_value os_build(napi_env env, napi_callback_info info) {
  (void)info;
  char build[128] = {0};
  int code = text_sysctl("kern.osversion", build, sizeof(build));
  if (code) return fail(env, "os-build", code);
  napi_value result;
  TRY(napi_create_string_utf8(env, build, NAPI_AUTO_LENGTH, &result));
  return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"captureRoot", NULL, capture_root, NULL, NULL, NULL, napi_default, NULL},
    {"captureDescendant", NULL, capture_descendant, NULL, NULL, NULL, napi_default, NULL},
    {"signalOriginal", NULL, signal_original, NULL, NULL, NULL, napi_default, NULL},
    {"observeOriginal", NULL, observe_original, NULL, NULL, NULL, napi_default, NULL},
    {"osBuild", NULL, os_build, NULL, NULL, NULL, napi_default, NULL},
  };
  TRY(napi_define_properties(env, exports, 5, methods));
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
