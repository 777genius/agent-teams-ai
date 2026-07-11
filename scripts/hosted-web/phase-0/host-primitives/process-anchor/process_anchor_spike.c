#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/prctl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum { EXIT_USAGE = 64, EXIT_PROTOCOL = 79 };

static volatile sig_atomic_t provider_stop = 0;

static void provider_term(int signal_number) {
  (void)signal_number;
  provider_stop = 1;
}

static void sleep_ms(unsigned long milliseconds) {
  struct timespec delay = {
      .tv_sec = (time_t)(milliseconds / 1000),
      .tv_nsec = (long)((milliseconds % 1000) * 1000000UL),
  };
  while (nanosleep(&delay, &delay) == -1 && errno == EINTR) {
  }
}

static void record_fds(const char *marker_path, const char *role) {
  int marker_fd = open(marker_path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (marker_fd == -1) {
    _exit(111);
  }
  DIR *directory = opendir("/proc/self/fd");
  if (directory == NULL) {
    _exit(112);
  }
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    char *end = NULL;
    long fd = strtol(entry->d_name, &end, 10);
    if (end == entry->d_name || *end != '\0') {
      continue;
    }
    char link_path[64];
    char target[512];
    snprintf(link_path, sizeof(link_path), "/proc/self/fd/%ld", fd);
    ssize_t count = readlink(link_path, target, sizeof(target) - 1);
    if (count >= 0) {
      target[count] = '\0';
      dprintf(marker_fd, "role=%s pid=%ld fd=%ld target=%s\n", role, (long)getpid(), fd,
              target);
    }
  }
  (void)closedir(directory);
  (void)close(marker_fd);
}

static int close_unintended_descriptors(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) {
    return 0;
  }
  if (errno != ENOSYS && errno != EPERM) {
    return -1;
  }
#endif
  DIR *directory = opendir("/proc/self/fd");
  if (directory == NULL) {
    return -1;
  }
  int directory_fd = dirfd(directory);
  int descriptors[4096];
  size_t count = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    char *end = NULL;
    long value = strtol(entry->d_name, &end, 10);
    if (end != entry->d_name && *end == '\0' && value >= 3 && value != directory_fd) {
      if (count >= sizeof(descriptors) / sizeof(descriptors[0])) {
        (void)closedir(directory);
        errno = EOVERFLOW;
        return -1;
      }
      descriptors[count++] = (int)value;
    }
  }
  (void)closedir(directory);
  for (size_t index = 0; index < count; index++) {
    (void)close(descriptors[index]);
  }
  return 0;
}

static void provider_loop(const char *marker_path, const char *role, bool ignore_term,
                          unsigned long bounded_lifetime_ms) {
  int null_fd = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (null_fd == -1) {
    _exit(110);
  }
  (void)dup2(null_fd, STDIN_FILENO);
  (void)dup2(null_fd, STDOUT_FILENO);
  (void)dup2(null_fd, STDERR_FILENO);
  if (null_fd > STDERR_FILENO) {
    (void)close(null_fd);
  }
  if (close_unintended_descriptors() == -1) {
    _exit(113);
  }
  record_fds(marker_path, role);
  if (ignore_term) {
    (void)signal(SIGTERM, SIG_IGN);
  } else {
    struct sigaction action = {.sa_handler = provider_term};
    sigemptyset(&action.sa_mask);
    (void)sigaction(SIGTERM, &action, NULL);
  }
  if (bounded_lifetime_ms > 0) {
    sleep_ms(bounded_lifetime_ms);
    _exit(0);
  }
  while (!provider_stop) {
    pause();
  }
  _exit(0);
}

static void spawn_provider_fixture(const char *mode, const char *marker_path) {
  if (strcmp(mode, "double") == 0 || strcmp(mode, "escape") == 0) {
    pid_t intermediate = fork();
    if (intermediate == -1) {
      _exit(120);
    }
    if (intermediate == 0) {
      pid_t grandchild = fork();
      if (grandchild == -1) {
        _exit(121);
      }
      if (grandchild == 0) {
        if (strcmp(mode, "escape") == 0 && setsid() == -1) {
          _exit(122);
        }
        provider_loop(marker_path, strcmp(mode, "escape") == 0 ? "escaped" : "grandchild",
                      strcmp(mode, "escape") == 0,
                      strcmp(mode, "escape") == 0 ? 600UL : 0UL);
      }
      _exit(0);
    }
  }
  provider_loop(marker_path, "main", strcmp(mode, "ignore") == 0, 0UL);
}

static int open_pidfd(pid_t pid) {
  int result = (int)syscall(SYS_pidfd_open, pid, 0);
  return result;
}

struct process_identity {
  pid_t ppid;
  pid_t pgrp;
  unsigned long long start_time;
};

struct pidfd_target {
  pid_t pid;
  int pidfd;
};

static bool read_proc_identity(pid_t pid, struct process_identity *identity) {
  char path[64];
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  FILE *file = fopen(path, "r");
  if (file == NULL) {
    return false;
  }
  char record[4096];
  char *line = fgets(record, sizeof(record), file);
  (void)fclose(file);
  if (line == NULL) {
    return false;
  }
  char *command_end = strrchr(record, ')');
  if (command_end == NULL || command_end[1] != ' ') {
    return false;
  }
  char *save = NULL;
  char *field = strtok_r(command_end + 2, " ", &save);
  size_t field_number = 3;
  bool have_ppid = false;
  bool have_pgrp = false;
  bool have_start_time = false;
  while (field != NULL) {
    if (field_number == 4) {
      identity->ppid = (pid_t)strtol(field, NULL, 10);
      have_ppid = true;
    } else if (field_number == 5) {
      identity->pgrp = (pid_t)strtol(field, NULL, 10);
      have_pgrp = true;
    } else if (field_number == 22) {
      identity->start_time = strtoull(field, NULL, 10);
      have_start_time = true;
      break;
    }
    field = strtok_r(NULL, " ", &save);
    field_number++;
  }
  return have_ppid && have_pgrp && have_start_time;
}

static size_t collect_descendants(pid_t anchor_pid, pid_t *output, size_t capacity) {
  pid_t known[1024];
  size_t known_count = 1;
  known[0] = anchor_pid;
  bool changed = true;
  while (changed) {
    changed = false;
    DIR *proc = opendir("/proc");
    if (proc == NULL) {
      return 0;
    }
    struct dirent *entry;
    while ((entry = readdir(proc)) != NULL) {
      char *end = NULL;
      long candidate_long = strtol(entry->d_name, &end, 10);
      if (end == entry->d_name || *end != '\0' || candidate_long <= 0) {
        continue;
      }
      pid_t candidate = (pid_t)candidate_long;
      bool already_known = false;
      for (size_t index = 0; index < known_count; index++) {
        if (known[index] == candidate) {
          already_known = true;
          break;
        }
      }
      if (already_known || known_count >= 1024) {
        continue;
      }
      struct process_identity identity;
      if (!read_proc_identity(candidate, &identity)) {
        continue;
      }
      for (size_t index = 0; index < known_count; index++) {
        if (known[index] == identity.ppid) {
          known[known_count++] = candidate;
          changed = true;
          break;
        }
      }
    }
    (void)closedir(proc);
  }
  size_t output_count = 0;
  for (size_t index = 1; index < known_count && output_count < capacity; index++) {
    output[output_count++] = known[index];
  }
  return output_count;
}

static int send_pidfd_signal(int pidfd, int signal_number) {
#ifdef SYS_pidfd_send_signal
  return (int)syscall(SYS_pidfd_send_signal, pidfd, signal_number, NULL, 0);
#else
  (void)pidfd;
  (void)signal_number;
  errno = ENOSYS;
  return -1;
#endif
}

static size_t snapshot_owned_targets(pid_t anchor_pid, pid_t owned_pgid,
                                     struct pidfd_target *targets, size_t capacity,
                                     bool *saw_escape, bool *saw_ambiguous) {
  pid_t descendants[1024];
  size_t count = collect_descendants(anchor_pid, descendants, 1024);
  size_t target_count = 0;
  for (size_t index = 0; index < count; index++) {
    struct process_identity before;
    if (!read_proc_identity(descendants[index], &before)) {
      continue;
    }
    int pidfd = open_pidfd(descendants[index]);
    if (pidfd == -1) {
      if (errno != ESRCH) {
        *saw_ambiguous = true;
      }
      continue;
    }
    struct process_identity after;
    if (!read_proc_identity(descendants[index], &after)) {
      (void)close(pidfd);
      continue;
    }
    if (before.start_time != after.start_time || before.ppid != after.ppid ||
        before.pgrp != after.pgrp) {
      *saw_ambiguous = true;
      (void)close(pidfd);
      continue;
    }
    if (after.pgrp != owned_pgid) {
      *saw_escape = true;
      (void)close(pidfd);
      continue;
    }
    if (target_count >= capacity) {
      *saw_ambiguous = true;
      (void)close(pidfd);
      continue;
    }
    targets[target_count++] = (struct pidfd_target){.pid = descendants[index], .pidfd = pidfd};
  }
  return target_count;
}

static size_t signal_owned_descendants(pid_t anchor_pid, pid_t owned_pgid, int signal_number,
                                       bool *saw_escape, bool *saw_ambiguous) {
  struct pidfd_target targets[1024];
  size_t count = snapshot_owned_targets(anchor_pid, owned_pgid, targets, 1024, saw_escape,
                                        saw_ambiguous);
  for (size_t index = 0; index < count; index++) {
    if (send_pidfd_signal(targets[index].pidfd, signal_number) == -1 && errno != ESRCH) {
      *saw_ambiguous = true;
    }
    (void)close(targets[index].pidfd);
  }
  return count;
}

static size_t reap_available(void) {
  size_t reaped = 0;
  int status = 0;
  while (waitpid(-1, &status, WNOHANG) > 0) {
    reaped++;
  }
  return reaped;
}

int main(int argc, char **argv) {
  if (argc != 9) {
    fprintf(stderr,
            "usage: %s NONCE MODE FD_MARKER GRACE_MS PURPOSE RESET_GENERATION "
            "DEPLOYMENT_GENERATION PROCESS_ANCHOR_GENERATION\n",
            argv[0]);
    return EXIT_USAGE;
  }
  const char *nonce = argv[1];
  const char *mode = argv[2];
  unsigned long grace_ms = strtoul(argv[4], NULL, 10);
  const char *purpose = argv[5];
  unsigned long reset_generation = strtoul(argv[6], NULL, 10);
  const char *deployment_generation = argv[7];
  const char *process_anchor_generation = argv[8];
  if (nonce[0] == '\0' ||
      (strcmp(mode, "normal") != 0 && strcmp(mode, "ignore") != 0 &&
       strcmp(mode, "double") != 0 && strcmp(mode, "escape") != 0) ||
      (strcmp(purpose, "pairing") != 0 && strcmp(purpose, "host_reset") != 0 &&
       strcmp(purpose, "runtime_stop") != 0) ||
      deployment_generation[0] == '\0' || process_anchor_generation[0] == '\0') {
    fprintf(stderr, "protocol_error\n");
    return EXIT_PROTOCOL;
  }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == -1 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == -1) {
    perror("anchor setup");
    return EXIT_PROTOCOL;
  }
  (void)signal(SIGTERM, SIG_IGN);
  if (close_unintended_descriptors() == -1) {
    perror("close inherited descriptors");
    return EXIT_PROTOCOL;
  }

  pid_t main_pid = fork();
  if (main_pid == -1) {
    perror("fork provider fixture");
    return EXIT_PROTOCOL;
  }
  if (main_pid == 0) {
    if (setpgid(0, 0) == -1) {
      _exit(123);
    }
    spawn_provider_fixture(mode, argv[3]);
  }
  if (setpgid(main_pid, main_pid) == -1 && errno != EACCES) {
    perror("allocate provider process group");
    return EXIT_PROTOCOL;
  }
  pid_t owned_pgid = main_pid;
  int main_pidfd = open_pidfd(main_pid);
  if (main_pidfd == -1) {
    perror("pidfd_open");
    return EXIT_PROTOCOL;
  }
  int pidfd_flags = fcntl(main_pidfd, F_GETFD);
  if (pidfd_flags == -1 || fcntl(main_pidfd, F_SETFD, pidfd_flags | FD_CLOEXEC) == -1) {
    perror("pidfd cloexec");
    return EXIT_PROTOCOL;
  }
  printf("type=ready protocolVersion=1 nonce=%s anchor=%ld main=%ld group=%ld pidfd=yes subreaper=yes "
         "processAnchorGeneration=%s\n",
         nonce, (long)getpid(), (long)main_pid, (long)owned_pgid,
         process_anchor_generation);
  fflush(stdout);

  char control[32];
  ssize_t control_count;
  do {
    control_count = read(STDIN_FILENO, control, sizeof(control));
  } while (control_count == -1 && errno == EINTR);
  const char *reason = control_count == 0 ? "controller_eof" : "typed_stop";
  if (control_count > 0 && strncmp(control, "STOP", 4) != 0) {
    printf("type=protocol_error code=invalid_control\n");
    fflush(stdout);
    reason = "protocol_error";
  }

  bool saw_escape = false;
  bool saw_ambiguous = false;
  (void)signal_owned_descendants(getpid(), owned_pgid, SIGTERM, &saw_escape,
                                 &saw_ambiguous);
  printf("type=escalation phase=term reason=%s via=pidfd_snapshot pidfd_main=yes "
         "numeric_pgid_signal=no\n",
         reason);
  fflush(stdout);
  unsigned long elapsed = 0;
  while (elapsed < grace_ms) {
    (void)reap_available();
    pid_t descendants[1024];
    if (collect_descendants(getpid(), descendants, 1024) == 0) {
      break;
    }
    (void)signal_owned_descendants(getpid(), owned_pgid, SIGTERM, &saw_escape,
                                   &saw_ambiguous);
    sleep_ms(10);
    elapsed += 10;
  }
  pid_t residual[1024];
  size_t residual_count = collect_descendants(getpid(), residual, 1024);
  if (residual_count > 0) {
    printf("type=escalation phase=kill residual=%zu via=pidfd_snapshot "
           "numeric_pgid_signal=no\n",
           residual_count);
    fflush(stdout);
  }
  for (int attempts = 0; attempts < 200; attempts++) {
    (void)reap_available();
    if (collect_descendants(getpid(), residual, 1024) == 0) {
      break;
    }
    (void)signal_owned_descendants(getpid(), owned_pgid, SIGKILL, &saw_escape,
                                   &saw_ambiguous);
    sleep_ms(10);
  }
  residual_count = collect_descendants(getpid(), residual, 1024);
  (void)close(main_pidfd);
  if (residual_count != 0 || saw_escape || saw_ambiguous) {
    char residual_labels[96] = "";
    if (residual_count != 0) {
      (void)strcat(residual_labels, "owned_residual");
    }
    if (saw_escape) {
      (void)strcat(residual_labels, residual_labels[0] == '\0' ? "escaped_group" : ",escaped_group");
    }
    if (saw_ambiguous) {
      (void)strcat(residual_labels,
                   residual_labels[0] == '\0' ? "ambiguous_identity" : ",ambiguous_identity");
    }
    printf("type=unclassified_residual protocolVersion=1 kind=process_drain_outcome_v1 outcome=unclassified "
           "purpose=%s resetGeneration=%lu deploymentGeneration=%s "
           "processAnchorGeneration=%s classificationId=anchor-%s-%ld residuals=[%s] "
           "residual=%zu escaped_group=%s ambiguous_identity=%s numeric_pid_signal=no "
           "numeric_pgid_signal=no container_replacement_required=yes\n",
           purpose, reset_generation, deployment_generation, process_anchor_generation,
           process_anchor_generation, (long)getpid(), residual_labels, residual_count,
           saw_escape ? "yes" : "no", saw_ambiguous ? "yes" : "no");
    fflush(stdout);
    return residual_count == 0 ? 0 : 2;
  }
  printf("type=drained protocolVersion=1 kind=process_drain_outcome_v1 outcome=drained purpose=%s "
         "resetGeneration=%lu deploymentGeneration=%s processAnchorGeneration=%s "
         "classificationId=anchor-%s-%ld residuals=[] residual=0 pidfd=yes subreaper=yes "
         "numeric_pid_signal=no numeric_pgid_signal=no\n",
         purpose, reset_generation, deployment_generation, process_anchor_generation,
         process_anchor_generation, (long)getpid());
  fflush(stdout);
  return 0;
}
