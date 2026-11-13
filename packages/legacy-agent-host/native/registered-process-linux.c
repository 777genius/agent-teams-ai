#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <gnu/libc-version.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/magic.h>
#include <math.h>
#include <node_api.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <unistd.h>

/* Private packaged Linux x64 adapter. Durable pidfs is preferred; the warm
 * path retains original pidfds. Neither uses PID/start ticks as signal authority. */
#if !defined(__x86_64__) || defined(__ILP32__)
#error Only the existing Linux x64 product tuple is in scope
#endif
/* Linux x86-64 syscall ABI: older glibc headers may predate pidfd_open.
 * arch/x86/entry/syscalls/syscall_64.tbl assigns 434; runtime probe still fails closed. */
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#define TRY(call) do { if ((call) != napi_ok) return fail(env, "napi", EIO); } while (0)
#define MAX_ANCESTRY 16
#ifndef PID_FS_MAGIC
#define PID_FS_MAGIC 0x50494446 /* Public pidfs ABI; runtime fstatfs must actually match. */
#endif
struct identity { pid_t pid, sid; uint64_t inode, ns; char boot[37]; };
struct vertex { struct identity id; pid_t parent, group; };
static napi_value fail(napi_env env, const char *stage, int code) {
  char message[96]; snprintf(message, sizeof(message), "%s:%d", stage, code);
  napi_throw_error(env, "registered-process-unavailable", message); return NULL;
}
static int context(char boot[37], uint64_t *ns) {
  char text[39] = {0};
  int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return errno;
  ssize_t size = read(fd, text, sizeof(text)); int error = errno; close(fd);
  if (size < 0) return error;
  if (size != 37 || text[36] != '\n') return EINVAL;
  memcpy(boot, text, 36); boot[36] = 0;
  struct stat st;
  if (stat("/proc/self/ns/pid", &st) < 0) return errno;
  *ns = (uint64_t)st.st_ino; return *ns ? 0 : EINVAL;
}
static int pidfd_id(int fd, uint64_t *out) {
  struct statfs fs; struct stat st;
  if (fstatfs(fd, &fs) < 0 || fstat(fd, &st) < 0) return errno;
  if ((unsigned long)fs.f_type != PID_FS_MAGIC || sizeof(st.st_ino) != 8 || !st.st_ino)
    return EOPNOTSUPP;
  *out = (uint64_t)st.st_ino; return 0;
}
static int alive(int fd) {
  struct pollfd item = { .fd = fd, .events = POLLIN };
  int result = poll(&item, 1, 0);
  if (result < 0) return errno;
  if (!result) return 0;
  return (item.revents & (POLLIN | POLLHUP)) ? ESRCH : EIO;
}
static int vertex_mode(int fd, pid_t pid, struct vertex *out, int durable) {
  int error = alive(fd); if (error) return error;
  out->id.inode = 0;
  if (durable && (error = pidfd_id(fd, &out->id.inode))) return error;
  char path[64], text[4096] = {0};
  snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  int statfd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (statfd < 0) return errno;
  ssize_t size = read(statfd, text, sizeof(text) - 1); error = errno; close(statfd);
  if (size < 0) return error;
  if (size == 0 || size >= (ssize_t)sizeof(text) - 1) return EINVAL;
  char *end = strrchr(text, ')'), state = 0;
  long parent = 0, group = 0, sid = 0;
  if (strtol(text, NULL, 10) != pid || !end || end[1] != ' ' ||
      sscanf(end + 2, "%c %ld %ld %ld", &state, &parent, &group, &sid) != 4 ||
      parent < 1 || parent > INT32_MAX || group < 1 || group > INT32_MAX || sid < 1 || sid > INT32_MAX)
    return EINVAL;
  /* A dead thread-group leader may still have live workers. Only pidfd polling
   * proves whole-process exit; a procfs state never turns that into absence. */
  if (state == 'Z' || state == 'X' || state == 'x') return EAGAIN;
  out->id.pid = pid; out->id.sid = (pid_t)sid;
  out->parent = (pid_t)parent; out->group = (pid_t)group;
  if ((error = context(out->id.boot, &out->id.ns))) return error;
  return alive(fd); /* Reject any exit/reuse during the procfs reads. */
}
static int vertex(int fd, pid_t pid, struct vertex *out) {
  return vertex_mode(fd, pid, out, 1);
}
static int open_vertex_mode(pid_t pid, struct vertex *out, int *retained, int durable) {
  int fd = (int)syscall(SYS_pidfd_open, pid, 0);
  if (fd < 0) return errno;
  int error = vertex_mode(fd, pid, out, durable);
  if (error) { close(fd); return error; }
  *retained = fd; return 0;
}
static int open_vertex(pid_t pid, struct vertex *out, int *retained) {
  return open_vertex_mode(pid, out, retained, 1);
}
static int same(const struct identity *a, const struct identity *b) {
  return a->pid == b->pid && a->inode == b->inode && a->ns == b->ns && !strcmp(a->boot, b->boot);
}
static int original(const struct identity *expected, struct vertex *current, int *retained) {
  char boot[37]; uint64_t ns;
  int error = context(boot, &ns); if (error) return error;
  if (strcmp(boot, expected->boot)) return ESTALE;
  if (ns != expected->ns) return EXDEV;
  int fd = (int)syscall(SYS_pidfd_open, expected->pid, 0);
  if (fd < 0) return errno;
  uint64_t inode = 0;
  error = pidfd_id(fd, &inode);
  if (!error && inode != expected->inode) error = ESTALE;
  if (!error) error = vertex(fd, expected->pid, current);
  if (!error && (!same(expected, &current->id) || current->id.sid != expected->sid)) error = EXDEV;
  if (error) { close(fd); return error; }
  *retained = fd; return 0;
}
static int parse_pid(napi_env env, napi_value value, pid_t *pid) {
  double n;
  if (napi_get_value_double(env, value, &n) != napi_ok || !isfinite(n) || n < 2 ||
      n > INT32_MAX || n != (double)(int32_t)n) return EINVAL;
  *pid = (pid_t)n; return 0;
}
static int property(napi_env env, napi_value object, const char *key, napi_value *out) {
  return napi_get_named_property(env, object, key, out) == napi_ok ? 0 : EINVAL;
}
static int decimal(napi_env env, napi_value value, uint64_t *out) {
  char text[24] = {0}; size_t length = 0;
  if (napi_get_value_string_utf8(env, value, text, sizeof(text), &length) != napi_ok ||
      length < 1 || length > 20 || text[0] == '0') return EINVAL;
  for (size_t i = 0; i < length; i++) if (text[i] < '0' || text[i] > '9') return EINVAL;
  errno = 0; unsigned long long number = strtoull(text, NULL, 10);
  if (errno || !number) return EINVAL;
  *out = (uint64_t)number; return 0;
}
static int parse_identity(napi_env env, napi_value value, struct identity *out) {
  napi_value item; size_t length = 0;
  if (property(env, value, "pid", &item) || parse_pid(env, item, &out->pid) ||
      property(env, value, "sessionId", &item) || parse_pid(env, item, &out->sid) ||
      property(env, value, "pidfdId", &item) || decimal(env, item, &out->inode) ||
      property(env, value, "pidNamespaceId", &item) || decimal(env, item, &out->ns) ||
      property(env, value, "bootId", &item) ||
      napi_get_value_string_utf8(env, item, out->boot, sizeof(out->boot), &length) != napi_ok || length != 36)
    return EINVAL;
  return 0;
}
static napi_value snapshot(napi_env env, const struct identity *id) {
  napi_value result, value; char text[24];
  TRY(napi_create_object(env, &result));
  TRY(napi_create_int32(env, id->pid, &value)); TRY(napi_set_named_property(env, result, "pid", value));
  TRY(napi_create_int32(env, id->sid, &value)); TRY(napi_set_named_property(env, result, "sessionId", value));
  if (id->inode) {
    snprintf(text, sizeof(text), "%" PRIu64, id->inode);
    TRY(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value));
    TRY(napi_set_named_property(env, result, "pidfdId", value));
  }
  snprintf(text, sizeof(text), "%" PRIu64, id->ns);
  TRY(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value));
  TRY(napi_set_named_property(env, result, "pidNamespaceId", value));
  TRY(napi_create_string_utf8(env, id->boot, NAPI_AUTO_LENGTH, &value));
  TRY(napi_set_named_property(env, result, "bootId", value)); return result;
}
static napi_value capture_root(napi_env env, napi_callback_info info) {
  napi_value args[1]; size_t count = 1; pid_t pid;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 1 || parse_pid(env, args[0], &pid)) return fail(env, "arguments", EINVAL);
  struct vertex root; int fd = -1, error = open_vertex(pid, &root, &fd);
  if (!error && (root.id.sid != pid || root.group != pid || root.parent != getpid())) error = EPERM;
  if (fd >= 0) close(fd);
  if (error) return fail(env, "original-root", error);
  return snapshot(env, &root.id);
}
/* Read an image only through the already proved original root descriptor. */
static napi_value executable_snapshot(napi_env env, const struct vertex *before, int retained, int durable) {
  struct vertex after; int image = -1, error = 0;
  if (before->parent != getpid() || before->id.sid != before->id.pid || before->group != before->id.pid)
    error = EPERM;
  char proc_path[64], executable[PATH_MAX] = {0}; struct stat measured;
  snprintf(proc_path, sizeof(proc_path), "/proc/%d/exe", before->id.pid);
  if (!error) { image = open(proc_path, O_RDONLY | O_CLOEXEC); if (image < 0) error = errno; }
  if (!error && fstat(image, &measured)) error = errno;
  if (!error && !S_ISREG(measured.st_mode)) error = EINVAL;
  if (!error) {
    ssize_t size = readlink(proc_path, executable, sizeof(executable) - 1);
    if (size < 0) error = errno;
    else if (size == 0 || size >= (ssize_t)sizeof(executable) - 1 || executable[0] != '/') error = EINVAL;
  }
  if (!error) error = vertex_mode(retained, before->id.pid, &after, durable);
  if (!error && (!same(&before->id, &after.id) || after.parent != before->parent ||
      after.group != before->group || after.id.sid != before->id.sid)) error = EAGAIN;
  if (image >= 0) close(image);
  if (error) return fail(env, "original-executable", error);
  napi_value value, result = snapshot(env, &after.id); if (result == NULL) return NULL;
  TRY(napi_create_string_utf8(env, executable, NAPI_AUTO_LENGTH, &value));
  TRY(napi_set_named_property(env, result, "executablePath", value));
  char text[24]; snprintf(text, sizeof(text), "%" PRIu64, (uint64_t)measured.st_dev);
  TRY(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value));
  TRY(napi_set_named_property(env, result, "executableDevice", value));
  snprintf(text, sizeof(text), "%" PRIu64, (uint64_t)measured.st_ino);
  TRY(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value));
  TRY(napi_set_named_property(env, result, "executableInode", value)); return result;
}
static napi_value read_root_executable(napi_env env, napi_callback_info info) {
  napi_value args[1]; size_t count = 1; struct identity expected;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 1 || parse_identity(env, args[0], &expected)) return fail(env, "arguments", EINVAL);
  struct vertex before; int retained = -1;
  int error = original(&expected, &before, &retained);
  if (error) return fail(env, "original-executable", error);
  napi_value result = executable_snapshot(env, &before, retained, 1);
  close(retained); return result;
}
static int lineage(const struct identity *root, int target_fd, const struct vertex *target, int durable) {
  struct vertex path[MAX_ANCESTRY], after; int handles[MAX_ANCESTRY];
  size_t length = 1; int error = 0;
  for (size_t i = 0; i < MAX_ANCESTRY; i++) handles[i] = -1;
  path[0] = *target; handles[0] = target_fd;
  while (!same(&path[length - 1].id, root)) {
    if (length == MAX_ANCESTRY || path[length - 1].parent <= 1) { error = EPERM; break; }
    pid_t parent = path[length - 1].parent;
    for (size_t i = 0; i < length; i++) if (path[i].id.pid == parent) error = ELOOP;
    if (error) break;
    error = open_vertex_mode(parent, &path[length], &handles[length], durable); if (error) break;
    length++;
  }
  for (size_t i = length; !error && i-- > 0;) {
    error = vertex_mode(handles[i], path[i].id.pid, &after, durable);
    if (!error && (!same(&path[i].id, &after.id) || after.parent != path[i].parent ||
        after.id.sid != path[i].id.sid || after.group != path[i].group)) error = ESRCH;
  }
  for (size_t i = 1; i < MAX_ANCESTRY; i++) if (handles[i] >= 0) close(handles[i]);
  return error;
}
static napi_value capture_descendant(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2; pid_t pid; struct identity expected;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 2 || parse_identity(env, args[0], &expected) || parse_pid(env, args[1], &pid) ||
      pid == expected.pid || pid == getpid() || pid == getppid()) return fail(env, "arguments", EINVAL);
  struct vertex root, target, after; int root_fd = -1, target_fd = -1;
  int error = original(&expected, &root, &root_fd);
  if (!error && (root.parent != getpid() || root.id.sid != root.id.pid || root.group != root.id.pid)) error = EPERM;
  if (!error) error = open_vertex(pid, &target, &target_fd);
  if (!error && target.id.sid != root.id.sid) error = lineage(&root.id, target_fd, &target, 1);
  if (!error) error = vertex(root_fd, root.id.pid, &after);
  if (!error && (!same(&root.id, &after.id) || after.parent != root.parent || after.group != root.group ||
      after.id.sid != root.id.sid || alive(target_fd))) error = ESRCH;
  if (root_fd >= 0) close(root_fd);
  if (target_fd >= 0) close(target_fd);
  if (error) return fail(env, "original-lineage", error);
  return snapshot(env, &target.id);
}
static napi_value observe_original(napi_env env, napi_callback_info info) {
  napi_value args[1], result; size_t count = 1; struct identity expected;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 1 || parse_identity(env, args[0], &expected)) return fail(env, "arguments", EINVAL);
  struct vertex now; int fd = -1, error = original(&expected, &now, &fd);
  if (fd >= 0) close(fd);
  const char *state = !error ? "same-live" : error == ESRCH ? "absent" : error == ESTALE ? "stale" : "unknown";
  TRY(napi_create_string_utf8(env, state, NAPI_AUTO_LENGTH, &result)); return result;
}
static napi_value signal_original(napi_env env, napi_callback_info info) {
  napi_value args[1], result; size_t count = 1; struct identity expected;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 1 || parse_identity(env, args[0], &expected) || expected.pid == getpid() ||
      expected.pid == getppid()) return fail(env, "arguments", EINVAL);
  struct vertex now; int fd = -1, error = original(&expected, &now, &fd);
  /* Caller persists requested before entry. The retained fd, never a PID, receives the signal. */
  if (!error && syscall(SYS_pidfd_send_signal, fd, SIGTERM, NULL, 0) < 0) error = errno;
  if (fd >= 0) close(fd);
  if (error) return fail(env, "original-signal", error);
  TRY(napi_create_int32(env, 0, &result)); return result; /* accepted, not exit proof */
}
/* Native descriptor objects are private capabilities, never serialized fd/PID numbers. */
struct warm_handle { int fd, root, exited; struct vertex original; };
static const napi_type_tag warm_tag = { UINT64_C(0x41c095f6a2db4e73), UINT64_C(0x95e8667842c3b7aa) };
static void warm_finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  struct warm_handle *handle = data;
  if (handle->fd >= 0) close(handle->fd);
  free(handle);
}
static int warm_parse(napi_env env, napi_value value, struct warm_handle **out) {
  bool tagged = false; void *data = NULL;
  if (napi_check_object_type_tag(env, value, &warm_tag, &tagged) != napi_ok || !tagged ||
      napi_get_value_external(env, value, &data) != napi_ok || !data) return EINVAL;
  *out = data; return 0;
}
/* Consumes fd on every path; its finalizer never calls JavaScript. */
static napi_value warm_snapshot(napi_env env, int fd, const struct vertex *original, int root) {
  struct warm_handle *handle = calloc(1, sizeof(*handle));
  if (!handle) { close(fd); return fail(env, "warm-allocation", ENOMEM); }
  handle->fd = fd; handle->root = root; handle->original = *original;
  napi_value external;
  if (napi_create_external(env, handle, warm_finalize, NULL, &external) != napi_ok) {
    warm_finalize(env, handle, NULL); return fail(env, "warm-allocation", EIO);
  }
  /* The external now owns cleanup, including any following N-API error. */
  TRY(napi_type_tag_object(env, external, &warm_tag));
  napi_value result = snapshot(env, &original->id); if (result == NULL) return NULL;
  TRY(napi_set_named_property(env, result, "handle", external)); return result;
}
static int warm_current(struct warm_handle *handle, struct vertex *out) {
  if (handle->fd < 0) return handle->exited ? ESRCH : EBADF;
  int error = vertex_mode(handle->fd, handle->original.id.pid, out, 0);
  if (!error && (!same(&handle->original.id, &out->id) ||
      handle->original.id.sid != out->id.sid)) error = EXDEV;
  return error;
}
static napi_value capture_warm_root(napi_env env, napi_callback_info info) {
  napi_value args[1]; size_t count = 1; pid_t pid;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 1 || parse_pid(env, args[0], &pid)) return fail(env, "arguments", EINVAL);
  struct vertex root; int fd = -1;
  int error = open_vertex_mode(pid, &root, &fd, 0);
  if (!error && (root.id.sid != pid || root.group != pid || root.parent != getpid())) error = EPERM;
  if (error) { if (fd >= 0) close(fd); return fail(env, "warm-root", error); }
  return warm_snapshot(env, fd, &root, 1);
}
static napi_value capture_warm_descendant(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2; pid_t pid; struct warm_handle *handle = NULL;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 2 || warm_parse(env, args[0], &handle) || !handle->root ||
      parse_pid(env, args[1], &pid) || pid == handle->original.id.pid ||
      pid == getpid() || pid == getppid()) return fail(env, "arguments", EINVAL);
  struct vertex root, target, after; int fd = -1;
  int error = warm_current(handle, &root);
  if (!error && (root.parent != getpid() || root.group != root.id.pid || root.id.sid != root.id.pid)) error = EPERM;
  if (!error) error = open_vertex_mode(pid, &target, &fd, 0);
  if (!error && target.id.sid != root.id.sid) error = lineage(&root.id, fd, &target, 0);
  if (!error) error = warm_current(handle, &after);
  if (!error && (root.parent != after.parent || root.group != after.group || alive(fd))) error = EAGAIN;
  if (error) { if (fd >= 0) close(fd); return fail(env, "warm-lineage", error); }
  return warm_snapshot(env, fd, &target, 0);
}
static napi_value read_warm_root_executable(napi_env env, napi_callback_info info) {
  napi_value args[1]; size_t count = 1; struct warm_handle *handle = NULL;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 1 || warm_parse(env, args[0], &handle) || !handle->root)
    return fail(env, "arguments", EINVAL);
  struct vertex root; int error = warm_current(handle, &root);
  if (error) return fail(env, "warm-executable", error);
  return executable_snapshot(env, &root, handle->fd, 0);
}
static napi_value observe_warm(napi_env env, napi_callback_info info) {
  napi_value args[1], result; size_t count = 1; struct warm_handle *handle = NULL;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 1 || warm_parse(env, args[0], &handle)) return fail(env, "arguments", EINVAL);
  struct vertex now; int error = warm_current(handle, &now);
  const char *state = !error ? "same-live" : error == ESRCH ? "absent" : "unknown";
  TRY(napi_create_string_utf8(env, state, NAPI_AUTO_LENGTH, &result)); return result;
}
static napi_value signal_warm(napi_env env, napi_callback_info info) {
  napi_value args[1], result; size_t count = 1; struct warm_handle *handle = NULL;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 1 || warm_parse(env, args[0], &handle) || handle->root ||
      handle->original.id.pid == getpid() || handle->original.id.pid == getppid())
    return fail(env, "arguments", EINVAL);
  struct vertex now; int error = warm_current(handle, &now);
  if (!error && syscall(SYS_pidfd_send_signal, handle->fd, SIGTERM, NULL, 0) < 0) error = errno;
  if (error) return fail(env, "warm-signal", error);
  TRY(napi_create_int32(env, 0, &result)); return result;
}
static napi_value close_warm(napi_env env, napi_callback_info info) {
  napi_value args[1], result; size_t count = 1; struct warm_handle *handle = NULL;
  TRY(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  if (count != 1 || warm_parse(env, args[0], &handle)) return fail(env, "arguments", EINVAL);
  if (handle->fd >= 0) {
    handle->exited = alive(handle->fd) == ESRCH;
    close(handle->fd); handle->fd = -1;
  }
  TRY(napi_get_undefined(env, &result)); return result;
}
static napi_value kernel_identity(napi_env env, napi_callback_info info) {
  (void)info; struct utsname name; int pidfd = 0, pidfs = 0;
  if (uname(&name)) return fail(env, "kernel-identity", errno);
  int fd = (int)syscall(SYS_pidfd_open, getpid(), 0);
  if (fd < 0) {
    if (errno != ENOSYS && errno != EPERM && errno != EACCES && errno != EINVAL)
      return fail(env, "pidfd-capability", errno);
  } else {
    uint64_t inode = 0;
    int error = alive(fd);
    if (!error && syscall(SYS_pidfd_send_signal, fd, 0, NULL, 0) < 0) error = errno;
    if (!error) {
      pidfd = 1; error = pidfd_id(fd, &inode);
      if (!error) pidfs = 1;
      else if (error == EOPNOTSUPP) error = 0;
    }
    close(fd);
    if (error && error != ENOSYS && error != EPERM && error != EACCES && error != EINVAL)
      return fail(env, "pidfd-capability", error);
  }
  napi_value result, value; TRY(napi_create_object(env, &result));
  TRY(napi_create_string_utf8(env, name.release, NAPI_AUTO_LENGTH, &value));
  TRY(napi_set_named_property(env, result, "kernelRelease", value));
  TRY(napi_create_string_utf8(env, name.machine, NAPI_AUTO_LENGTH, &value));
  TRY(napi_set_named_property(env, result, "machine", value));
  TRY(napi_create_string_utf8(env, gnu_get_libc_version(), NAPI_AUTO_LENGTH, &value));
  TRY(napi_set_named_property(env, result, "glibcVersion", value));
  TRY(napi_get_boolean(env, pidfd != 0, &value)); TRY(napi_set_named_property(env, result, "pidfd", value));
  TRY(napi_get_boolean(env, pidfs != 0, &value)); TRY(napi_set_named_property(env, result, "pidfs", value));
  return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"captureRoot", NULL, capture_root, NULL, NULL, NULL, napi_default, NULL},
    {"readRootExecutable", NULL, read_root_executable, NULL, NULL, NULL, napi_default, NULL},
    {"captureDescendant", NULL, capture_descendant, NULL, NULL, NULL, napi_default, NULL},
    {"observeOriginal", NULL, observe_original, NULL, NULL, NULL, napi_default, NULL},
    {"signalOriginal", NULL, signal_original, NULL, NULL, NULL, napi_default, NULL},
    {"kernelIdentity", NULL, kernel_identity, NULL, NULL, NULL, napi_default, NULL},
    {"captureWarmRoot", NULL, capture_warm_root, NULL, NULL, NULL, napi_default, NULL},
    {"captureWarmDescendant", NULL, capture_warm_descendant, NULL, NULL, NULL, napi_default, NULL},
    {"readWarmRootExecutable", NULL, read_warm_root_executable, NULL, NULL, NULL, napi_default, NULL},
    {"observeWarm", NULL, observe_warm, NULL, NULL, NULL, napi_default, NULL},
    {"signalWarm", NULL, signal_warm, NULL, NULL, NULL, napi_default, NULL},
    {"closeWarm", NULL, close_warm, NULL, NULL, NULL, napi_default, NULL},
  };
  TRY(napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods)); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
