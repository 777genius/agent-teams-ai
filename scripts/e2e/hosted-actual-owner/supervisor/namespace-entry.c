#define _GNU_SOURCE
/* Selected supervisor namespace entry, Linux C17. This is a materialization
 * component, not an admission verifier. The selected JS entry must authenticate
 * its independently provisioned roots and the plan before launching producers.
 * No success transcript or producer evidence is manufactured here. */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/mount.h>
#include <linux/capability.h>
#include <linux/securebits.h>
#include <net/if.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
/* Test hooks exist only in the focused source-inclusion harness. */
#ifndef NAMESPACE_TEST_PHASE
#define NAMESPACE_TEST_PHASE(phase) ((void)0)
#endif
#ifndef NAMESPACE_TEST_FAILURE
#define NAMESPACE_TEST_FAILURE(phase) ((void)0)
#endif
static sigset_t wait_signals;
static volatile sig_atomic_t stopping;
static void stop(int sig) { stopping = sig; }
static void fail(const char *phase) {
  int saved = errno;
  NAMESPACE_TEST_FAILURE(phase);
  dprintf(STDERR_FILENO, "selected_namespace_%s:errno=%d\n", phase, saved);
  _exit(125);
}
static void require(int ok, const char *phase) { if (!ok) fail(phase); }
static void directory(const char *path) {
  require(mkdir(path, 0700) == 0, "mkdir");
}
static void close_from(unsigned int first) {
  require(syscall(SYS_close_range, first, ~0U, 0) == 0, "close_range");
}
static void death_guard(pid_t parent) {
  require(prctl(PR_SET_PDEATHSIG, SIGKILL) == 0 && getppid() == parent,
    "parent_changed");
}
/* FD3 is the existing controller-created Linux Unix socketpair. Its kernel
 * peer credentials survive controller death, unlike a fresh getppid snapshot.
 * Reject reparenting even if it happened before entry (including to a subreaper).
 * No descriptor allocation or plan consumption is needed to bind this guard. */
static void controller_guard(void) {
  NAMESPACE_TEST_PHASE("before_controller_peer");
  struct ucred peer;
  socklen_t length = sizeof peer;
  require(getsockopt(3, SOL_SOCKET, SO_PEERCRED, &peer, &length) == 0 &&
    length == sizeof peer && peer.pid > 0 && peer.uid == 0, "controller_peer");
  NAMESPACE_TEST_PHASE("before_controller_guard");
  death_guard(peer.pid);
  NAMESPACE_TEST_PHASE("controller_guarded");
}
static void prepare_wait(void) {
  sigemptyset(&wait_signals);
  sigaddset(&wait_signals, SIGTERM);
  sigaddset(&wait_signals, SIGINT);
  sigaddset(&wait_signals, SIGCHLD);
  require(sigprocmask(SIG_BLOCK, &wait_signals, NULL) == 0, "signal_block");
  struct sigaction action = { .sa_handler = stop };
  sigemptyset(&action.sa_mask);
  require(sigaction(SIGTERM, &action, NULL) == 0 &&
    sigaction(SIGINT, &action, NULL) == 0, "signals");
  action.sa_handler = SIG_DFL;
  require(sigaction(SIGCHLD, &action, NULL) == 0, "sigchld");
}
static void drop_setup_privileges(void) {
  /* UID 0 remains the ordinary owner of the selected 0700 artifacts. It has
   * no capability override. Locked NOROOT removes root's exec capability
   * special case; bounding/ambient/inheritable sets and NNP close exec regain. */
  require(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0, "no_new_privs");
  require(prctl(PR_SET_SECUREBITS, SECBIT_NOROOT | SECBIT_NOROOT_LOCKED |
    SECBIT_NO_SETUID_FIXUP | SECBIT_NO_SETUID_FIXUP_LOCKED |
    SECBIT_KEEP_CAPS_LOCKED | SECBIT_NO_CAP_AMBIENT_RAISE |
    SECBIT_NO_CAP_AMBIENT_RAISE_LOCKED) == 0, "securebits");
  require(prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) == 0, "ambient_clear");
  for (int cap = 0;; ++cap) {
    int present = prctl(PR_CAPBSET_READ, cap, 0, 0, 0);
    if (present < 0 && errno == EINVAL) break;
    require(present >= 0, "bounding_read");
    require(prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) == 0, "bounding_drop");
  }
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3 };
  struct __user_cap_data_struct empty[2] = {{0}, {0}};
  require(syscall(SYS_capset, &header, empty) == 0, "capabilities_clear");
}
static void relative_path(const char *path) {
  size_t n = strlen(path);
  require(n > 0 && n < 512 && path[0] != '/' && path[n - 1] != '/', "path");
  const char *segment = path;
  for (const char *p = path;; ++p) {
    require(*p == 0 || (*p >= '!' && *p <= '~' && *p != '\\' && *p != ':'), "path_byte");
    if (*p == '/' || *p == 0) {
      size_t length = (size_t)(p - segment);
      require(length && !(length == 1 && segment[0] == '.') &&
        !(length == 2 && segment[0] == '.' && segment[1] == '.'), "path_segment");
      if (!*p) break;
      segment = p + 1;
    }
  }
}
/* Inherited descriptors retain pre-unshare mounts. Resolve the kernel path
 * afresh, then pin and compare the object before any mount operation. */
static int local_input(int fd) {
  char magic[64], path[PATH_MAX];
  snprintf(magic, sizeof magic, "/proc/self/fd/%d", fd);
  ssize_t length = readlink(magic, path, sizeof path - 1);
  require(length > 0 && length < (ssize_t)sizeof path - 1, "input_local_path");
  path[length] = 0;
  require(path[0] == '/', "input_local_absolute");
  int local = open(path, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  struct stat held, reopened;
  require(local >= 0 && fstat(fd, &held) == 0 && fstat(local, &reopened) == 0 &&
    held.st_dev == reopened.st_dev && held.st_ino == reopened.st_ino &&
    held.st_mode == reopened.st_mode, "input_local_identity");
  return local;
}
static void bind_input(int fd, const char *target, int is_directory, int readonly) {
  struct stat st;
  require(fstat(fd, &st) == 0 &&
    (is_directory ? S_ISDIR(st.st_mode) : S_ISREG(st.st_mode)), "input_kind");
  if (is_directory) directory(target);
  else {
    int out = open(target, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    require(out >= 0, "mount_file");
    require(close(out) == 0, "mount_file_close");
  }
  int local = local_input(fd);
  char source[64];
  require(snprintf(source, sizeof source, "/proc/self/fd/%d", local) > 0, "source_path");
  require(mount(source, target, NULL, MS_BIND | (is_directory ? MS_REC : 0), NULL) == 0,
    "bind");
  require(close(local) == 0, "input_local_close");
  struct mount_attr attributes = { .attr_set = MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV |
    (readonly ? MOUNT_ATTR_RDONLY : 0) };
  require(syscall(SYS_mount_setattr, AT_FDCWD, target, AT_RECURSIVE,
    &attributes, sizeof attributes) == 0, "mount_attributes");
}
static void loopback(void) {
  int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(fd >= 0, "network_socket");
  struct ifreq request = {0};
  memcpy(request.ifr_name, "lo", 3);
  require(ioctl(fd, SIOCGIFFLAGS, &request) == 0, "loopback_get");
  request.ifr_flags |= IFF_UP;
  require(ioctl(fd, SIOCSIFFLAGS, &request) == 0, "loopback_up");
  require(close(fd) == 0, "network_close");
}
static void filesystem(void) {
  struct stat sandbox;
  require(fstat(10, &sandbox) == 0 && S_ISDIR(sandbox.st_mode) &&
    sandbox.st_uid == 0 && (sandbox.st_mode & 0777) == 0700, "sandbox");
  /* FD10 predates CLONE_NEWNS: its vfsmount still belongs to the old mount
   * namespace. Mounting through that magic link fails check_mnt with EINVAL.
   * Reopen its kernel-reported path in this namespace and verify the held
   * identity before using the new descriptor as a mount target. The path is
   * not supplied by the plan; replacement or an unreachable sandbox fails. */
  char root[96], sandbox_source[64];
  int local_sandbox = local_input(10);
  require(mkdirat(local_sandbox, ".selected-namespace-root", 0700) == 0, "fresh_root");
  int root_length = snprintf(root, sizeof root, "/proc/self/fd/%d/.selected-namespace-root",
    local_sandbox);
  require(root_length > 0 && root_length < (int)sizeof root, "root_path");
  require(mount("tmpfs", root, "tmpfs", MS_NOSUID | MS_NODEV, "mode=0700,size=64m") == 0,
    "tmpfs");
  require(chdir(root) == 0, "root_cwd");
  bind_input(4, "product", 1, 1);
  bind_input(5, "browser", 1, 1);
  bind_input(6, "owner", 0, 1);
  bind_input(7, "opencode", 0, 1);
  /* Nonrecursive sandbox bind excludes the root tmpfs just constructed. */
  directory("sandbox");
  snprintf(sandbox_source, sizeof sandbox_source, "/proc/self/fd/%d", local_sandbox);
  require(mount(sandbox_source, "sandbox", NULL, MS_BIND, NULL) == 0, "sandbox_bind");
  require(close(local_sandbox) == 0, "sandbox_local_close");
  struct mount_attr sandbox_attributes = { .attr_set = MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV };
  require(syscall(SYS_mount_setattr, AT_FDCWD, "sandbox", 0,
    &sandbox_attributes, sizeof sandbox_attributes) == 0, "sandbox_attributes");
  bind_input(11, "toolchain", 1, 1);
  /* The pinned toolchain closure must include the ELF interpreter and shared
   * libraries at these paths. The toolchain 'loader' pin is Node's JS import
   * loader, not ld.so. Never exec ld.so and call its image identity Node's. */
  require(symlink("toolchain/lib", "lib") == 0 &&
    symlink("toolchain/lib64", "lib64") == 0, "toolchain_libraries");
  bind_input(12, "p3b2", 1, 1);
  bind_input(13, "composition", 0, 1);
  /* Individual public documents only. Never expose the controller directory,
   * one-run ledger, private signing keys or another host directory. */
  directory("admission");
  bind_input(14, "admission/freeze.json", 0, 1);
  bind_input(15, "admission/review.json", 0, 1);
  bind_input(16, "admission/authorization.json", 0, 1);
  bind_input(17, "admission/reviewer.spki", 0, 1);
  bind_input(18, "admission/authorizer.spki", 0, 1);
  directory("proc"); directory("dev"); directory(".old-root");
  require(mount("tmpfs", "dev", "tmpfs", MS_NOSUID | MS_NOEXEC,
    "mode=0755,size=1m") == 0, "dev_mount");
  require(mknod("dev/null", S_IFCHR | 0666, makedev(1, 3)) == 0, "dev_null");
  require(mknod("dev/urandom", S_IFCHR | 0444, makedev(1, 9)) == 0, "dev_urandom");
  require(syscall(SYS_pivot_root, ".", ".old-root") == 0 && chdir("/") == 0, "pivot");
  require(umount2("/.old-root", MNT_DETACH) == 0 && rmdir("/.old-root") == 0, "old_root");
  require(mount("proc", "/proc", "proc", MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) == 0,
    "proc_mount");
  require(mount(NULL, "/", NULL, MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV, NULL) == 0,
    "root_readonly");
  /* No inherited host directory or executable description reaches Node. FD3
   * remains its bounded plan stream; producer descriptors are allocated later. */
  close_from(4);
}
static int status_code(int status) {
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
static int wait_child(pid_t child, int reap_namespace) {
  int status;
  for (;;) {
    if (stopping) {
      /* Direct unreaped child only. The namespace init is protected by
       * PDEATHSIG, and its death tears down its private PID namespace. */
      require(kill(child, SIGKILL) == 0 || errno == ESRCH, "cancel_child");
    }
    NAMESPACE_TEST_PHASE("wait_after_stop_check");
    pid_t observed = waitpid(reap_namespace ? -1 : child, &status, WNOHANG);
    if (observed == child) return status_code(status);
    if (observed > 0 && reap_namespace) continue;
    if (observed == 0) {
      /* Signals stay blocked across the flag check and WNOHANG reap. A signal
       * in that interval remains pending for sigwaitinfo, never a lost wake. */
      int sig = sigwaitinfo(&wait_signals, NULL);
      if (sig == SIGTERM || sig == SIGINT) stopping = sig;
      else require(sig == SIGCHLD || (sig < 0 && errno == EINTR), "signal_wait");
      continue;
    }
    if (observed < 0 && errno == EINTR) continue;
    fail("wait_child");
  }
}
int main(int argc, char **argv) {
  /* Args are selected materialization paths, not environment discovery:
   * namespace-entry --selected-namespace-v1 loader-relative node-relative module-relative
   * loader-relative is the existing Node --import loader. */
  require(argc == 5 && strcmp(argv[1], "--selected-namespace-v1") == 0 &&
    getuid() == 0 && geteuid() == 0, "invocation");
  for (int i = 2; i < 5; ++i) relative_path(argv[i]);
  require(getenv("LD_PRELOAD") == NULL && getenv("LD_LIBRARY_PATH") == NULL &&
    getenv("NODE_OPTIONS") == NULL && getenv("NODE_PATH") == NULL, "ambient_loader");
  controller_guard();
  prepare_wait();
  require(unshare(CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWPID | CLONE_NEWUTS) == 0,
    "unshare");
  require(mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) == 0, "private_mounts");
  int parent_pidfd = (int)syscall(SYS_pidfd_open, getpid(), 0);
  require(parent_pidfd >= 0, "parent_pidfd");
  NAMESPACE_TEST_PHASE("before_init_fork");
  pid_t init = fork();
  require(init >= 0, "fork_init");
  if (init > 0) { NAMESPACE_TEST_PHASE("after_init_fork"); close_from(3); return wait_child(init, 0); }
  /* Parent is outside this PID namespace: getppid() is zero. The guard must
   * check that namespace-visible relationship, not compare host PID numbers. */
  NAMESPACE_TEST_PHASE("init_before_guard");
  death_guard(0);
  /* getppid()==0 alone cannot detect death of an out-of-namespace parent.
   * Check its inherited pidfd after arming PDEATHSIG to close that race. */
  struct pollfd parent_alive = { .fd = parent_pidfd, .events = POLLIN };
  require(poll(&parent_alive, 1, 0) == 0, "parent_dead");
  require(close(parent_pidfd) == 0, "parent_pidfd_close");
  require(getpid() == 1, "pid_namespace");
  loopback(); filesystem();
  drop_setup_privileges();
  NAMESPACE_TEST_PHASE("before_worker_fork");
  pid_t worker = fork();
  require(worker >= 0, "fork_supervisor");
  if (worker == 0) {
    NAMESPACE_TEST_PHASE("worker_before_guard");
    death_guard(1);
    /* Supervisors own their signal policy; do not leak the reaper mask. */
    sigset_t empty;
    sigemptyset(&empty);
    require(sigprocmask(SIG_SETMASK, &empty, NULL) == 0, "worker_signal_mask");
    char loader[PATH_MAX], node[PATH_MAX], module[PATH_MAX];
    snprintf(loader, sizeof loader, "/toolchain/%s", argv[2]);
    snprintf(node, sizeof node, "/toolchain/%s", argv[3]);
    snprintf(module, sizeof module, "/p3b2/%s", argv[4]);
    require(chdir("/sandbox/run") == 0, "supervisor_cwd");
    char *selected[] = {node, "--import", loader, module, "--selected-supervisor-v1", NULL};
    execve(node, selected, environ);
    fail("exec_supervisor");
  }
  NAMESPACE_TEST_PHASE("after_worker_fork");
  require(close(3) == 0, "init_plan_close");
  int result = wait_child(worker, 1);
  /* This PID1 owns only this new namespace. Its exit terminates remaining
   * descendants in-kernel; it never signals a host PID or shared process group. */
  return result;
}
