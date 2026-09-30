#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC (1U << 2)
#endif

enum {
  INSTANCE_LEASE_FD = 3,
  INSTANCE_LEASE_CONTROL_FD = 4,
  EXIT_USAGE = 64,
  EXIT_LEASE_BUSY = 73,
  EXIT_ANCHOR_REJECTED = 74,
  EXIT_CHILD_LAUNCH_FAILED = 75,
};

static volatile sig_atomic_t child_pid_for_signal = -1;

#ifdef AGENT_TEAMS_INSTANCE_LOCK_TEST_HOOKS
static int test_reap_gate_fd = -1;
static int test_forward_audit_fd = -1;

static int test_fd_from_environment(const char *name) {
  const char *value = getenv(name);
  if (value == NULL || value[0] == '\0') {
    return -1;
  }
  char *end = NULL;
  errno = 0;
  const long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed < 0 || parsed > INT_MAX) {
    return -1;
  }
  return (int)parsed;
}

static void configure_test_hooks(void) {
  test_reap_gate_fd = test_fd_from_environment("AGENT_TEAMS_TEST_REAP_GATE_FD");
  test_forward_audit_fd =
      test_fd_from_environment("AGENT_TEAMS_TEST_FORWARD_AUDIT_FD");
}

static void pause_at_unreaped_child_boundary(void) {
  if (test_reap_gate_fd < 0) {
    return;
  }
  const char ready = 'R';
  if (write(test_reap_gate_fd, &ready, 1) != 1) {
    return;
  }
  char release = '\0';
  ssize_t result;
  do {
    result = read(test_reap_gate_fd, &release, 1);
  } while (result == -1 && errno == EINTR);
  if (result != 1 || release != 'G') {
    _exit(EXIT_CHILD_LAUNCH_FAILED);
  }
}
#else
static void configure_test_hooks(void) {}
static void pause_at_unreaped_child_boundary(void) {}
#endif

static void write_diagnostic(const char *message) {
  const size_t length = strlen(message);
  ssize_t ignored = write(STDERR_FILENO, message, length);
  (void)ignored;
}

static void forward_signal(int signal_number) {
  const int saved_errno = errno;
  const pid_t child_pid = (pid_t)child_pid_for_signal;
  if (child_pid > 0) {
#ifdef AGENT_TEAMS_INSTANCE_LOCK_TEST_HOOKS
    if (test_forward_audit_fd >= 0) {
      const char forwarded = 'F';
      ssize_t ignored = write(test_forward_audit_fd, &forwarded, 1);
      (void)ignored;
    }
#endif
    (void)kill(child_pid, signal_number);
  }
  errno = saved_errno;
}

static int reject_anchor(const char *message) {
  fprintf(stderr, "instance_lock:anchor_rejected:%s\n", message);
  return EXIT_ANCHOR_REJECTED;
}

static bool parse_kernel_identity(const char *value, uintmax_t *result) {
  if (value == NULL || value[0] == '\0' || value[0] == '-') {
    return false;
  }

  char *end = NULL;
  errno = 0;
  const uintmax_t parsed = strtoumax(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') {
    return false;
  }
  *result = parsed;
  return true;
}

static bool is_safe_anchor_name(const char *name) {
  return name != NULL && name[0] != '\0' && strcmp(name, ".") != 0 &&
         strcmp(name, "..") != 0 && strchr(name, '/') == NULL;
}

static bool parent_is_safe(const struct stat *parent_stat) {
  return S_ISDIR(parent_stat->st_mode) && parent_stat->st_uid == 0 &&
         (parent_stat->st_mode & (S_IWGRP | S_IWOTH)) == 0;
}

static bool anchor_is_safe(const struct stat *anchor_stat, uintmax_t expected_device,
                           uintmax_t expected_inode) {
  return S_ISREG(anchor_stat->st_mode) && anchor_stat->st_uid == 0 &&
         (anchor_stat->st_mode & (S_IWGRP | S_IWOTH)) == 0 &&
         anchor_stat->st_nlink == 1 && (uintmax_t)anchor_stat->st_dev == expected_device &&
         (uintmax_t)anchor_stat->st_ino == expected_inode;
}

static bool path_still_names_anchor(int parent_fd, const char *anchor_name,
                                    const struct stat *opened_anchor_stat) {
  struct stat path_stat;
  if (fstatat(parent_fd, anchor_name, &path_stat, AT_SYMLINK_NOFOLLOW) == -1) {
    return false;
  }
  return S_ISREG(path_stat.st_mode) && path_stat.st_uid == 0 && path_stat.st_nlink == 1 &&
         path_stat.st_dev == opened_anchor_stat->st_dev &&
         path_stat.st_ino == opened_anchor_stat->st_ino;
}

static int mark_all_non_protocol_fds_close_on_exec(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, ~0U, CLOSE_RANGE_CLOEXEC) == 0) {
    return 0;
  }
  if (errno != ENOSYS && errno != EINVAL) {
    return -1;
  }
#endif

  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) == -1) {
    return -1;
  }
  rlim_t maximum = limit.rlim_cur;
  if (maximum == RLIM_INFINITY) {
    maximum = 1024U * 1024U;
  }
  for (int fd = 3; (rlim_t)fd < maximum; fd += 1) {
    const int flags = fcntl(fd, F_GETFD);
    if (flags >= 0 && fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == -1) {
      return -1;
    }
    if (flags == -1 && errno != EBADF) {
      return -1;
    }
  }
  return 0;
}

static int install_reserved_fd(int source_fd, int reserved_fd) {
  if (source_fd == reserved_fd) {
    const int flags = fcntl(source_fd, F_GETFD);
    return flags == -1 ? -1 : fcntl(source_fd, F_SETFD, flags & ~FD_CLOEXEC);
  }
  return dup3(source_fd, reserved_fd, 0);
}

static int restore_child_signal_state(const sigset_t *controller_mask) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) == -1 || sigaction(SIGINT, &action, NULL) == -1 ||
      sigprocmask(SIG_SETMASK, controller_mask, NULL) == -1) {
    return -1;
  }
  return 0;
}

static void report_child_setup_error_and_exit(int error_fd, int error_number) {
  const int value = error_number == 0 ? EIO : error_number;
  ssize_t ignored = write(error_fd, &value, sizeof(value));
  (void)ignored;
  _exit(EXIT_CHILD_LAUNCH_FAILED);
}

static void exec_controller(int lease_fd, int control_read_fd, int control_write_fd,
                            int start_read_fd, int start_write_fd, int error_read_fd,
                            int error_write_fd, char *const child_argv[],
                            const sigset_t *controller_mask) {
  (void)close(control_write_fd);
  (void)close(start_write_fd);
  (void)close(error_read_fd);

  char start_byte = '\0';
  ssize_t start_length;
  do {
    start_length = read(start_read_fd, &start_byte, 1);
  } while (start_length == -1 && errno == EINTR);
  if (start_length != 1 || start_byte != 'G') {
    report_child_setup_error_and_exit(error_write_fd, EPROTO);
  }
  (void)close(start_read_fd);

  const int child_lease_fd = fcntl(lease_fd, F_DUPFD_CLOEXEC, 200);
  if (child_lease_fd == -1) {
    report_child_setup_error_and_exit(error_write_fd, errno);
  }
  const int child_control_fd = fcntl(control_read_fd, F_DUPFD_CLOEXEC, 200);
  if (child_control_fd == -1) {
    report_child_setup_error_and_exit(error_write_fd, errno);
  }

  if (mark_all_non_protocol_fds_close_on_exec() == -1 ||
      install_reserved_fd(child_lease_fd, INSTANCE_LEASE_FD) == -1 ||
      install_reserved_fd(child_control_fd, INSTANCE_LEASE_CONTROL_FD) == -1) {
    report_child_setup_error_and_exit(error_write_fd, errno);
  }

  if (restore_child_signal_state(controller_mask) == -1) {
    report_child_setup_error_and_exit(error_write_fd, errno);
  }
  execv(child_argv[0], child_argv);
  report_child_setup_error_and_exit(error_write_fd, errno);
}

static bool write_all(int fd, const char *buffer, size_t length) {
  size_t written = 0;
  while (written < length) {
    const ssize_t result = write(fd, buffer + written, length - written);
    if (result > 0) {
      written += (size_t)result;
      continue;
    }
    if (result == -1 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return true;
}

static int child_exit_status(int status) {
  if (WIFEXITED(status)) {
    return WEXITSTATUS(status);
  }
  if (WIFSIGNALED(status)) {
    return 128 + WTERMSIG(status);
  }
  return EXIT_CHILD_LAUNCH_FAILED;
}

static int wait_for_child_without_pid_reuse(pid_t child_pid,
                                            const sigset_t *forwarding_signals) {
  siginfo_t child_info;
  memset(&child_info, 0, sizeof(child_info));
  int wait_result;
  do {
    wait_result = waitid(P_PID, (id_t)child_pid, &child_info, WEXITED | WNOWAIT);
  } while (wait_result == -1 && errno == EINTR);
  if (wait_result == -1) {
    sigset_t ignored_mask;
    (void)sigprocmask(SIG_BLOCK, forwarding_signals, &ignored_mask);
    child_pid_for_signal = -1;
    return EXIT_CHILD_LAUNCH_FAILED;
  }

  sigset_t mask_before_reap;
  if (sigprocmask(SIG_BLOCK, forwarding_signals, &mask_before_reap) == -1) {
    child_pid_for_signal = -1;
    return EXIT_CHILD_LAUNCH_FAILED;
  }
  child_pid_for_signal = -1;
  pause_at_unreaped_child_boundary();

  int status = 0;
  while (waitpid(child_pid, &status, 0) == -1) {
    if (errno != EINTR) {
      (void)sigprocmask(SIG_SETMASK, &mask_before_reap, NULL);
      return EXIT_CHILD_LAUNCH_FAILED;
    }
  }
  if (sigprocmask(SIG_SETMASK, &mask_before_reap, NULL) == -1) {
    return EXIT_CHILD_LAUNCH_FAILED;
  }
  return child_exit_status(status);
}

int main(int argc, char **argv) {
  configure_test_hooks();
  if (argc < 7 || strcmp(argv[5], "--") != 0 || argv[1][0] != '/' ||
      argv[6][0] != '/' || !is_safe_anchor_name(argv[2])) {
    fprintf(stderr,
            "usage: %s ABS_PARENT ANCHOR EXPECTED_DEVICE EXPECTED_INODE -- "
            "ABS_NODE [ARG ...]\n",
            argv[0]);
    return EXIT_USAGE;
  }

  uintmax_t expected_device = 0;
  uintmax_t expected_inode = 0;
  if (!parse_kernel_identity(argv[3], &expected_device) ||
      !parse_kernel_identity(argv[4], &expected_inode) || expected_inode == 0) {
    return reject_anchor("invalid_expected_identity");
  }

  sigset_t forwarding_signals;
  sigemptyset(&forwarding_signals);
  sigaddset(&forwarding_signals, SIGTERM);
  sigaddset(&forwarding_signals, SIGINT);
  // A caller's inherited mask must not disable bounded shutdown. Until a child
  // exists, the default TERM/INT dispositions safely release any acquired FD.
  if (sigprocmask(SIG_UNBLOCK, &forwarding_signals, NULL) == -1) {
    return reject_anchor("signal_unmask_failed");
  }

  const int parent_fd = open(argv[1], O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent_fd == -1) {
    return reject_anchor("parent_open_failed");
  }
  struct stat parent_stat;
  if (fstat(parent_fd, &parent_stat) == -1 || !parent_is_safe(&parent_stat)) {
    (void)close(parent_fd);
    return reject_anchor("unsafe_parent");
  }

  const int lease_fd =
      openat(parent_fd, argv[2], O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (lease_fd == -1) {
    (void)close(parent_fd);
    return reject_anchor("anchor_open_failed");
  }
  struct stat anchor_stat;
  if (fstat(lease_fd, &anchor_stat) == -1 ||
      !anchor_is_safe(&anchor_stat, expected_device, expected_inode) ||
      !path_still_names_anchor(parent_fd, argv[2], &anchor_stat)) {
    (void)close(lease_fd);
    (void)close(parent_fd);
    return reject_anchor("unsafe_or_replaced_anchor");
  }

  if (flock(lease_fd, LOCK_EX | LOCK_NB) == -1) {
    const int lock_errno = errno;
    (void)close(lease_fd);
    (void)close(parent_fd);
    if (lock_errno == EWOULDBLOCK || lock_errno == EAGAIN) {
      write_diagnostic("instance_lock:lease_busy\n");
      return EXIT_LEASE_BUSY;
    }
    return reject_anchor("lock_failed");
  }

  if (!path_still_names_anchor(parent_fd, argv[2], &anchor_stat)) {
    (void)close(lease_fd);
    (void)close(parent_fd);
    return reject_anchor("anchor_changed_after_lock");
  }

  int control_pipe[2];
  int start_pipe[2];
  int exec_error_pipe[2];
  if (pipe2(control_pipe, O_CLOEXEC | O_NONBLOCK) == -1 ||
      pipe2(start_pipe, O_CLOEXEC) == -1 ||
      pipe2(exec_error_pipe, O_CLOEXEC) == -1) {
    (void)close(lease_fd);
    (void)close(parent_fd);
    return reject_anchor("pipe_setup_failed");
  }

  sigset_t controller_mask;
  if (sigprocmask(SIG_BLOCK, &forwarding_signals, &controller_mask) == -1) {
    return reject_anchor("signal_mask_failed");
  }

  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) == -1 || sigaction(SIGINT, &action, NULL) == -1) {
    return reject_anchor("signal_handler_failed");
  }
  action.sa_handler = SIG_DFL;
  if (sigaction(SIGCHLD, &action, NULL) == -1) {
    return reject_anchor("child_signal_handler_failed");
  }

  const pid_t child_pid = fork();
  if (child_pid == -1) {
    return reject_anchor("fork_failed");
  }
  if (child_pid == 0) {
    exec_controller(lease_fd, control_pipe[0], control_pipe[1], start_pipe[0], start_pipe[1],
                    exec_error_pipe[0], exec_error_pipe[1], &argv[6], &controller_mask);
  }

  child_pid_for_signal = (sig_atomic_t)child_pid;
  if (sigprocmask(SIG_SETMASK, &controller_mask, NULL) == -1) {
    (void)kill(child_pid, SIGKILL);
    (void)wait_for_child_without_pid_reuse(child_pid, &forwarding_signals);
    return reject_anchor("signal_unmask_failed");
  }
  (void)close(control_pipe[0]);
  (void)close(start_pipe[0]);
  (void)close(exec_error_pipe[1]);
  (void)close(parent_fd);

  char evidence[512];
  const int evidence_length = snprintf(
      evidence, sizeof(evidence),
      "{\"protocolVersion\":1,\"launcherPid\":%ld,\"controllerPid\":%ld,"
      "\"device\":\"%" PRIuMAX "\",\"inode\":\"%" PRIuMAX
      "\",\"mode\":%ju,\"uid\":%ju,\"nlink\":%ju}\n",
      (long)getpid(), (long)child_pid, (uintmax_t)anchor_stat.st_dev,
      (uintmax_t)anchor_stat.st_ino, (uintmax_t)anchor_stat.st_mode,
      (uintmax_t)anchor_stat.st_uid, (uintmax_t)anchor_stat.st_nlink);
  if (evidence_length <= 0 || (size_t)evidence_length >= sizeof(evidence) ||
      !write_all(control_pipe[1], evidence, (size_t)evidence_length)) {
    (void)kill(child_pid, SIGKILL);
    (void)wait_for_child_without_pid_reuse(child_pid, &forwarding_signals);
    (void)close(control_pipe[1]);
    (void)close(exec_error_pipe[0]);
    (void)close(lease_fd);
    return EXIT_CHILD_LAUNCH_FAILED;
  }
  if (!write_all(start_pipe[1], "G", 1)) {
    (void)kill(child_pid, SIGKILL);
    (void)wait_for_child_without_pid_reuse(child_pid, &forwarding_signals);
    (void)close(start_pipe[1]);
    (void)close(control_pipe[1]);
    (void)close(exec_error_pipe[0]);
    (void)close(lease_fd);
    return EXIT_CHILD_LAUNCH_FAILED;
  }
  (void)close(start_pipe[1]);

  int exec_error = 0;
  ssize_t exec_error_length;
  do {
    exec_error_length = read(exec_error_pipe[0], &exec_error, sizeof(exec_error));
  } while (exec_error_length == -1 && errno == EINTR);
  (void)close(exec_error_pipe[0]);
  if (exec_error_length != 0) {
    (void)wait_for_child_without_pid_reuse(child_pid, &forwarding_signals);
    (void)close(control_pipe[1]);
    (void)close(lease_fd);
    fprintf(stderr, "instance_lock:child_exec_failed:%d\n",
            exec_error_length == (ssize_t)sizeof(exec_error) ? exec_error : EIO);
    return EXIT_CHILD_LAUNCH_FAILED;
  }

  const int child_status = wait_for_child_without_pid_reuse(child_pid, &forwarding_signals);
  (void)close(control_pipe[1]);
  (void)close(lease_fd);
  return child_status;
}
