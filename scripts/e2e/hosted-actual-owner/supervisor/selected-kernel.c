#define _GNU_SOURCE
/* Narrow Linux/Node observation primitives. No process spawning, namespace
 * setup, authority issuance, network listener or daemon lives in this module. */
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <sys/syscall.h>
#include <unistd.h>

static napi_value rejected(napi_env env) {
  napi_throw_error(env, NULL, "selected_kernel_operation_rejected");
  return NULL;
}
static int integer(napi_env env, napi_value value, int32_t *out) {
  double number;
  return napi_get_value_double(env, value, &number) == napi_ok &&
    napi_get_value_int32(env, value, out) == napi_ok && number == (double)*out;
}
static napi_value open_pidfd(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; int32_t pid;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !integer(env, args[0], &pid) || pid < 1) return rejected(env);
  int fd = (int)syscall(SYS_pidfd_open, pid, 0);
  if (fd < 0) return rejected(env);
  napi_value result;
  if (napi_create_int32(env, fd, &result) != napi_ok) { close(fd); return rejected(env); }
  return result;
}
static napi_value signal_pidfd(napi_env env, napi_callback_info info) {
  size_t count = 3; napi_value args[3]; int32_t fd, sig;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2 ||
      !integer(env, args[0], &fd) || fd < 3 || !integer(env, args[1], &sig) ||
      (sig != 0 && sig != SIGTERM && sig != SIGKILL)) return rejected(env);
  int status = (int)syscall(SYS_pidfd_send_signal, fd, sig, NULL, 0);
  if (status < 0 && errno != ESRCH) return rejected(env);
  napi_value result;
  if (napi_get_boolean(env, status == 0, &result) != napi_ok) return rejected(env);
  return result;
}
static napi_value exited_pidfd(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; int32_t fd;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !integer(env, args[0], &fd) || fd < 3) return rejected(env);
  struct pollfd item = { .fd = fd, .events = POLLIN };
  int status;
  do { status = poll(&item, 1, 0); } while (status < 0 && errno == EINTR);
  if (status < 0 || (item.revents & (POLLNVAL | POLLERR))) return rejected(env);
  napi_value result;
  if (napi_get_boolean(env, (item.revents & (POLLIN | POLLHUP)) != 0, &result) != napi_ok) return rejected(env);
  return result;
}
static napi_value probe_openat2(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; int32_t root;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !integer(env, args[0], &root) || root < 3) return rejected(env);
  struct open_how how = { .flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
  int fd = (int)syscall(SYS_openat2, root, ".", &how, sizeof how);
  if (fd < 0) return rejected(env);
  if (close(fd) != 0) return rejected(env);
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return rejected(env);
  return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    { "pidfdOpen", NULL, open_pidfd, NULL, NULL, NULL, napi_default, NULL },
    { "pidfdSendSignal", NULL, signal_pidfd, NULL, NULL, NULL, napi_default, NULL },
    { "pidfdExited", NULL, exited_pidfd, NULL, NULL, NULL, napi_default, NULL },
    { "probeOpenat2", NULL, probe_openat2, NULL, NULL, NULL, napi_default, NULL },
  };
  if (napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) != napi_ok)
    return rejected(env);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
