#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum { EXIT_BUSY = 73, EXIT_ANCHOR = 74, EXIT_USAGE = 64 };

static int lock_fd = -1;
static int control_write_fd = -1;
static pid_t controller_pid = -1;

static void fail(const char *message) {
  perror(message);
  exit(EXIT_ANCHOR);
}

static uint64_t parse_u64(const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') {
    fprintf(stderr, "invalid integer: %s\n", value);
    exit(EXIT_USAGE);
  }
  return (uint64_t)parsed;
}

static void sleep_ms(unsigned long milliseconds) {
  struct timespec delay = {
      .tv_sec = (time_t)(milliseconds / 1000),
      .tv_nsec = (long)((milliseconds % 1000) * 1000000UL),
  };
  while (nanosleep(&delay, &delay) == -1 && errno == EINTR) {
  }
}

static void forward_signal(int signal_number) {
  if (controller_pid > 0) {
    (void)kill(controller_pid, signal_number);
  }
}

static int open_verified_anchor(const char *parent_path, const char *anchor_name,
                                uint64_t expected_device, uint64_t expected_inode) {
  int parent_fd = open(parent_path, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (parent_fd == -1) {
    fail("open deployment parent");
  }

  struct stat parent_stat;
  if (fstat(parent_fd, &parent_stat) == -1) {
    fail("fstat deployment parent");
  }
  if (!S_ISDIR(parent_stat.st_mode) || (parent_stat.st_mode & 0022) != 0) {
    fprintf(stderr, "unsafe deployment parent mode\n");
    exit(EXIT_ANCHOR);
  }

  int anchor_fd = openat(parent_fd, anchor_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (anchor_fd == -1) {
    fail("open instance anchor");
  }
  (void)close(parent_fd);

  struct stat anchor_stat;
  if (fstat(anchor_fd, &anchor_stat) == -1) {
    fail("fstat instance anchor");
  }
  if (!S_ISREG(anchor_stat.st_mode) || anchor_stat.st_uid != 0 ||
      (anchor_stat.st_mode & 0022) != 0 ||
      (uint64_t)anchor_stat.st_dev != expected_device ||
      (uint64_t)anchor_stat.st_ino != expected_inode) {
    fprintf(stderr, "instance anchor identity or ownership mismatch\n");
    exit(EXIT_ANCHOR);
  }
  return anchor_fd;
}

static void controller_main(int inherited_lock_fd, int control_read_fd, int ready_write_fd,
                            const char *effect_path, const char *owner_id) {
  if (dup2(inherited_lock_fd, 9) == -1) {
    fail("reserve controller lease fd");
  }
  if (inherited_lock_fd != 9) {
    (void)close(inherited_lock_fd);
  }
  int flags = fcntl(9, F_GETFD);
  if (flags == -1 || fcntl(9, F_SETFD, flags | FD_CLOEXEC) == -1) {
    fail("set controller lease close-on-exec");
  }

  int effect_fd = open(effect_path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (effect_fd == -1) {
    fail("open effect marker");
  }
  dprintf(effect_fd, "%s\n", owner_id);
  (void)fsync(effect_fd);
  (void)close(effect_fd);
  if (write(ready_write_fd, "R", 1) != 1) {
    fail("publish controller readiness");
  }
  (void)close(ready_write_fd);

  char byte;
  while (read(control_read_fd, &byte, 1) == -1 && errno == EINTR) {
  }
  (void)close(control_read_fd);
  (void)close(9);
  _exit(0);
}

int main(int argc, char **argv) {
  if (argc != 7) {
    fprintf(stderr,
            "usage: %s PARENT ANCHOR EXPECTED_DEV EXPECTED_INO EFFECT OWNER_ID\n",
            argv[0]);
    return EXIT_USAGE;
  }

  uint64_t expected_device = parse_u64(argv[3]);
  uint64_t expected_inode = parse_u64(argv[4]);
  lock_fd = open_verified_anchor(argv[1], argv[2], expected_device, expected_inode);
  if (flock(lock_fd, LOCK_EX | LOCK_NB) == -1) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) {
      fprintf(stderr, "lease_busy\n");
      return EXIT_BUSY;
    }
    fail("flock instance anchor");
  }

  int controller_lock_fd = dup(lock_fd);
  if (controller_lock_fd == -1) {
    fail("duplicate lease fd");
  }
  int control_pipe[2];
  if (pipe2(control_pipe, O_CLOEXEC) == -1) {
    fail("create lifecycle control pipe");
  }
  int ready_pipe[2];
  if (pipe2(ready_pipe, O_CLOEXEC) == -1) {
    fail("create readiness pipe");
  }

  controller_pid = fork();
  if (controller_pid == -1) {
    fail("fork controller fixture");
  }
  if (controller_pid == 0) {
    (void)close(control_pipe[1]);
    (void)close(ready_pipe[0]);
    (void)close(lock_fd);
    controller_main(controller_lock_fd, control_pipe[0], ready_pipe[1], argv[5], argv[6]);
  }

  (void)close(controller_lock_fd);
  (void)close(control_pipe[0]);
  (void)close(ready_pipe[1]);
  control_write_fd = control_pipe[1];
  struct sigaction action = {.sa_handler = forward_signal};
  sigemptyset(&action.sa_mask);
  (void)sigaction(SIGTERM, &action, NULL);
  (void)sigaction(SIGINT, &action, NULL);

  char ready_byte = '\0';
  if (read(ready_pipe[0], &ready_byte, 1) != 1 || ready_byte != 'R') {
    fail("await controller readiness");
  }
  (void)close(ready_pipe[0]);
  printf("ready launcher=%ld controller=%ld lock_fd=%d\n", (long)getpid(),
         (long)controller_pid, lock_fd);
  fflush(stdout);

  const char *close_launcher = getenv("ATG_CLOSE_LAUNCHER_LOCK_AFTER_READY");
  if (close_launcher != NULL && strcmp(close_launcher, "1") == 0) {
    sleep_ms(100);
    (void)close(lock_fd);
    lock_fd = -1;
    printf("launcher_lock_closed\n");
    fflush(stdout);
  }

  int status = 0;
  while (waitpid(controller_pid, &status, 0) == -1 && errno == EINTR) {
  }
  (void)close(control_write_fd);
  if (lock_fd >= 0) {
    (void)close(lock_fd);
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128;
}
