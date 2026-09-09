#define _GNU_SOURCE
/* Root-only, disposable kernel regression source. No JS or expected JSON.
 * Include the production implementation so race gates cannot drift to a model. */
#include <stdatomic.h>
#include <sys/mman.h>
#include <linux/futex.h>
#include <time.h>
static void phase(const char *name);
static void failure(const char *name);
#define NAMESPACE_TEST_PHASE(name) phase(name)
#define NAMESPACE_TEST_FAILURE(name) failure(name)
#define main namespace_entry_main
#include "../../../../../scripts/e2e/hosted-actual-owner/supervisor/namespace-entry.c"
#undef main

struct gates {
  atomic_int arrived, release, killing, rejected, setup_error, attack_ack;
  char target[64];
};
static struct gates *gates;
static int injected_signal;
static void failure(const char *name) {
  if (!gates) return; /* The exec attack reports failure through FD3 EOF. */
  if (atomic_load(&gates->killing) &&
      (!strcmp(name, "parent_changed") || !strcmp(name, "parent_dead"))) {
    atomic_fetch_add(&gates->rejected, 1);
    return;
  }
  atomic_store(&gates->setup_error, 1);
  atomic_store(&gates->arrived, -1);
  /* Do not use require here: this is already the failure path. */
  (void)syscall(SYS_futex, &gates->arrived, FUTEX_WAKE, INT_MAX, NULL, NULL, 0);
}
static void wake(atomic_int *word) {
  require(syscall(SYS_futex, word, FUTEX_WAKE, INT_MAX, NULL, NULL, 0) >= 0, "test_wake");
}
static void await(atomic_int *word) {
  struct timespec limit = { .tv_sec = 3 };
  while (!atomic_load(word)) {
    int rc = (int)syscall(SYS_futex, word, FUTEX_WAIT, 0, &limit, NULL, 0);
    require(rc == 0 || errno == EAGAIN || errno == EINTR, "test_gate_timeout");
  }
}
static void phase(const char *name) {
  if (strcmp(name, "before_worker_fork") == 0) {
    /* A post-exec check alone would miss setup privileges retained by PID1. */
    struct __user_cap_header_struct h = { .version = _LINUX_CAPABILITY_VERSION_3 };
    struct __user_cap_data_struct caps[2] = {{0}, {0}};
    require(syscall(SYS_capget, &h, caps) == 0, "test_init_capget");
    for (int i = 0; i < 2; ++i)
      require(!caps[i].effective && !caps[i].permitted && !caps[i].inheritable,
        "test_init_caps_before_fork");
    require(prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1, "test_init_nnp");
  }
  if (injected_signal && strcmp(name, "wait_after_stop_check") == 0) {
    int sig = injected_signal;
    injected_signal = 0;
    require(raise(sig) == 0, "test_inject");
  }
  if (gates && strcmp(name, gates->target) == 0) {
    atomic_store(&gates->arrived, 1); wake(&gates->arrived);
    await(&gates->release);
  }
}
static int bounded_reap(pid_t pid) {
  int fd = (int)syscall(SYS_pidfd_open, pid, 0);
  require(fd >= 0, "test_pidfd");
  struct pollfd p = { .fd = fd, .events = POLLIN };
  require(poll(&p, 1, 3000) == 1 && (p.revents & POLLIN), "test_exit_timeout");
  close(fd);
  int status;
  require(waitpid(pid, &status, 0) == pid, "test_reap");
  return status;
}
static void write_file(const char *path, const char *bytes) {
  int fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0700);
  require(fd >= 0 && write(fd, bytes, strlen(bytes)) == (ssize_t)strlen(bytes), "test_file");
  require(close(fd) == 0, "test_file_close");
}
static void unchanged(const char *path) {
  char bytes[16] = {0};
  int fd = open(path, O_RDONLY);
  require(fd >= 0 && read(fd, bytes, sizeof bytes) == 8 &&
    memcmp(bytes, "sentinel", 8) == 0, "test_sentinel_changed");
  close(fd);
}
static void denied(int rc) {
  require(rc == -1 && (errno == EPERM || errno == EACCES || errno == EROFS), "test_attack_allowed");
}
/* Executed as the selected ELF, through the production direct execve path.
 * Static linkage makes this fixture self-contained; it does not replace the
 * separate integration gate for the pinned real Node ELF/library closure. */
static int attack(void) {
  sigset_t mask;
  require(sigprocmask(SIG_SETMASK, NULL, &mask) == 0 &&
    sigismember(&mask, SIGTERM) == 0 && sigismember(&mask, SIGINT) == 0 &&
    sigismember(&mask, SIGCHLD) == 0, "test_exec_signal_mask");
  struct __user_cap_header_struct h = { .version = _LINUX_CAPABILITY_VERSION_3 };
  struct __user_cap_data_struct caps[2] = {{0}, {0}};
  require(syscall(SYS_capget, &h, caps) == 0, "test_capget");
  for (int i = 0; i < 2; ++i)
    require(!caps[i].effective && !caps[i].permitted && !caps[i].inheritable, "test_caps_survived_exec");
  require(prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1, "test_nnp");
  for (int cap = 0;; ++cap) {
    int b = prctl(PR_CAPBSET_READ, cap, 0, 0, 0);
    if (b < 0 && errno == EINVAL) break;
    require(b == 0 && prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, cap, 0, 0) == 0,
      "test_regain_sets");
  }
  denied(prctl(PR_SET_SECUREBITS, 0));
  caps[0].effective = caps[0].permitted = 1U << CAP_SYS_ADMIN;
  denied((int)syscall(SYS_capset, &h, caps));
  denied(mount(NULL, "/product", NULL, MS_REMOUNT | MS_BIND, NULL));
  struct mount_attr attr = { .attr_clr = MOUNT_ATTR_RDONLY };
  denied((int)syscall(SYS_mount_setattr, AT_FDCWD, "/product", AT_RECURSIVE, &attr, sizeof attr));
  denied(open("/product/sentinel", O_WRONLY | O_TRUNC));
  denied(sethostname("escaped", 7));
  denied(open("/proc/sys/kernel/hostname", O_WRONLY));
  denied(open("/proc/sysrq-trigger", O_WRONLY));
  unchanged("/product/sentinel"); /* Root-owned 0700 directory and file remain readable. */
  char plan;
  require(read(3, &plan, 1) == 1 && plan == 'P', "test_plan");
  int ready[2]; require(pipe(ready) == 0, "test_descendant_pipe");
  pid_t descendant = fork(); require(descendant >= 0, "test_descendant_fork");
  if (!descendant) {
    close(ready[0]);
    require(write(ready[1], "D", 1) == 1, "test_descendant_ready");
    close(ready[1]);
    for (;;) pause();
  }
  close(ready[1]);
  char byte; require(read(ready[0], &byte, 1) == 1 && byte == 'D', "test_descendant_ack");
  close(ready[0]);
  require(write(3, "A", 1) == 1, "test_attack_ack");
  /* Nonterminating worker: controller death must kill it in-kernel. */
  for (;;) pause();
  return 0; /* Unreachable; retain strict C compiler return-path acceptance. */
}
static void fixtures(int self) {
  directory("product"); directory("browser"); directory("toolchain");
  directory("p3b2"); directory("sandbox"); directory("sandbox/run");
  write_file("product/sentinel", "sentinel"); write_file("input", "sentinel");
  int out = open("toolchain/node", O_CREAT | O_EXCL | O_WRONLY, 0700);
  require(out >= 0 && lseek(self, 0, SEEK_SET) == 0, "test_elf");
  char block[8192]; ssize_t n;
  while ((n = read(self, block, sizeof block)) > 0)
    require(write(out, block, (size_t)n) == n, "test_elf_copy");
  require(n == 0 && close(out) == 0, "test_elf_close");
}
static void launch(int plan) {
  /* Reserve sources above the public ABI before dup2, avoiding collisions. */
  int held_plan = fcntl(plan, F_DUPFD_CLOEXEC, 32);
  require(held_plan >= 0, "test_reserve_plan");
  int source[19];
  for (int fd = 4; fd <= 18; ++fd) {
    const char *path = fd == 4 ? "product" : fd == 5 ? "browser" :
      fd == 10 ? "sandbox" : fd == 11 ? "toolchain" : fd == 12 ? "p3b2" : "input";
    int opened = open(path, O_RDONLY | O_CLOEXEC);
    require(opened >= 0, "test_open_input");
    source[fd] = fcntl(opened, F_DUPFD_CLOEXEC, 32);
    require(source[fd] >= 0, "test_reserve_input"); close(opened);
  }
  require(dup2(held_plan, 3) == 3, "test_plan_slot");
  for (int fd = 4; fd <= 18; ++fd) {
    require(dup2(source[fd], fd) == fd, "test_input_slot");
    struct stat held, mapped;
    require(fstat(source[fd], &held) == 0 && fstat(fd, &mapped) == 0 &&
      held.st_dev == mapped.st_dev && held.st_ino == mapped.st_ino &&
      held.st_mode == mapped.st_mode, "test_input_slot_identity");
  }
  close_from(19);
  char *args[] = {"namespace-entry", "--selected-namespace-v1", "loader", "node", "module", NULL};
  _exit(namespace_entry_main(5, args));
}
static void controller_case(const char *target) {
  atomic_store(&gates->arrived, 0); atomic_store(&gates->release, 0);
  atomic_store(&gates->killing, 0); atomic_store(&gates->rejected, 0);
  atomic_store(&gates->setup_error, 0); atomic_store(&gates->attack_ack, 0);
  snprintf(gates->target, sizeof gates->target, "%s", target);
  dprintf(STDERR_FILENO, "namespace_test_case:%s\n", target);
  pid_t controller = fork(); require(controller >= 0, "test_controller_fork");
  if (!controller) {
    int pair[2];
    require(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0, "test_socketpair");
    pid_t launcher = fork(); require(launcher >= 0, "test_launcher_fork");
    if (!launcher) { close(pair[0]); launch(pair[1]); }
    close(pair[1]);
    require(write(pair[0], "P", 1) == 1, "test_deliver");
    if (strcmp(target, "after_plan") == 0) {
      char ack;
      require(read(pair[0], &ack, 1) == 1 && ack == 'A', "test_attacks_failed");
      atomic_store(&gates->attack_ack, 1);
      phase("after_plan");
    }
    for (;;) pause();
  }
  await(&gates->arrived);
  require(atomic_load(&gates->arrived) == 1 && !atomic_load(&gates->setup_error),
    "test_case_setup_failed");
  if (!strcmp(target, "after_plan"))
    require(atomic_load(&gates->attack_ack) == 1, "test_positive_attack_ack");
  atomic_store(&gates->killing, 1);
  require(kill(controller, SIGKILL) == 0, "test_kill_controller");
  int controller_status = bounded_reap(controller);
  require(WIFSIGNALED(controller_status) && WTERMSIG(controller_status) == SIGKILL,
    "test_controller_status");
  atomic_store(&gates->release, 1); wake(&gates->release);
  /* Subreaper adopts the launcher. Reap each owned child with a deadline,
   * including namespace PID1 if reparented here. No process-group/global kill. */
  int reaped = 0;
  for (;;) {
    siginfo_t info = {0};
    int rc = waitid(P_ALL, 0, &info, WEXITED | WNOHANG | WNOWAIT);
    if (rc < 0 && errno == ECHILD) break;
    require(rc == 0, "test_waitid");
    if (info.si_pid) { (void)bounded_reap(info.si_pid); ++reaped; continue; }
    /* Discover only direct adopted children in this test's private proc. */
    char path[80], bytes[1024] = {0};
    snprintf(path, sizeof path, "/proc/self/task/%d/children", getpid());
    int fd = open(path, O_RDONLY);
    require(fd >= 0, "test_children_open");
    ssize_t n = read(fd, bytes, sizeof bytes - 1); close(fd);
    require(n > 0 && n < (ssize_t)sizeof bytes - 1, "test_children_read");
    pid_t adopted = (pid_t)strtol(bytes, NULL, 10);
    require(adopted > 0, "test_adopted"); (void)bounded_reap(adopted);
    ++reaped;
  }
  require(reaped > 0 && !atomic_load(&gates->setup_error), "test_lifecycle_setup_error");
  dprintf(STDERR_FILENO, "namespace_test_case_reaped:%s:children=%d:expected_rejections=%d\n",
    target, reaped, atomic_load(&gates->rejected));
  unchanged("product/sentinel");
  char hostname[64]; require(gethostname(hostname, sizeof hostname) == 0 &&
    strcmp(hostname, "namespace-test-outside") == 0, "test_uts_changed");
  /* Production deliberately requires a fresh root for every launch. */
  int root_removed = rmdir("sandbox/.selected-namespace-root");
  int setup_completed = !strcmp(target, "before_worker_fork") ||
    !strcmp(target, "after_worker_fork") || !strcmp(target, "worker_before_guard") ||
    !strcmp(target, "after_plan");
  require(root_removed == 0 || (!setup_completed && errno == ENOENT), "test_root_cleanup");
}
static void lost_wake(int sig) {
  pid_t reaper = fork(); require(reaper >= 0, "test_reaper_fork");
  if (!reaper) {
    gates = NULL; prepare_wait();
    pid_t child = fork(); require(child >= 0, "test_stubborn_fork");
    if (!child) { death_guard(getppid()); for (;;) pause(); }
    injected_signal = sig;
    require(wait_child(child, 0) == 128 + SIGKILL, "test_cancel_status");
    int status; require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "test_not_reaped");
    _exit(0);
  }
  require(bounded_reap(reaper) == 0, "test_lost_wake");
}
int main(int argc, char **argv) {
  if (argc == 5 && strcmp(argv[1], "--import") == 0) return attack();
  require(argc == 1 && getuid() == 0, "test_root_required");
  pid_t harness = getpid();
  pid_t outside = fork(); require(outside >= 0, "test_outside_fork");
  if (!outside) { death_guard(harness); for (;;) pause(); }
  int self = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
  require(self >= 0, "test_self");
  /* No mutations before disposable outer mount/UTS/network/PID isolation.
   * Host-side process holds only this test child, never unrelated processes. */
  require(unshare(CLONE_NEWNS | CLONE_NEWUTS | CLONE_NEWNET | CLONE_NEWPID) == 0, "test_outer_unshare");
  require(mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) == 0, "test_outer_private");
  pid_t outer = fork(); require(outer >= 0, "test_outer_fork");
  if (outer) {
    int fd = (int)syscall(SYS_pidfd_open, outer, 0);
    require(fd >= 0, "test_outer_pidfd");
    struct pollfd p = { .fd = fd, .events = POLLIN };
    int ready = poll(&p, 1, 30000);
    if (ready != 1) require(kill(outer, SIGKILL) == 0 || errno == ESRCH, "test_timeout_cleanup");
    int status; require(waitpid(outer, &status, 0) == outer, "test_outer_reap");
    /* A live sentinel outside BOTH PID namespaces must remain untouched. */
    int sentinel_status;
    require(waitpid(outside, &sentinel_status, WNOHANG) == 0 &&
      kill(outside, 0) == 0, "test_outside_touched");
    require(kill(outside, SIGKILL) == 0 &&
      waitpid(outside, &sentinel_status, 0) == outside, "test_outside_cleanup");
    require(ready == 1 && status == 0, "test_suite_failed");
    puts("namespace security kernel assertions passed"); return 0;
  }
  death_guard(0);
  require(mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) == 0, "test_outer_proc");
  require(mount("tmpfs", "/tmp", "tmpfs", MS_NOSUID | MS_NODEV, "mode=0700") == 0 &&
    chdir("/tmp") == 0, "test_outer_tmp");
  require(sethostname("namespace-test-outside", 22) == 0, "test_outer_hostname");
  require(prctl(PR_SET_CHILD_SUBREAPER, 1) == 0, "test_subreaper");
  gates = mmap(NULL, sizeof *gates, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  require(gates != MAP_FAILED, "test_shared_gates");
  fixtures(self); close(self);
  const char *cases[] = {"before_controller_peer", "before_controller_guard", "controller_guarded", "before_init_fork",
    "after_init_fork", "init_before_guard", "before_worker_fork",
    "after_worker_fork", "worker_before_guard", "after_plan"};
  for (size_t i = 0; i < sizeof cases / sizeof cases[0]; ++i) controller_case(cases[i]);
  lost_wake(SIGTERM); lost_wake(SIGINT);
  return 0;
}
