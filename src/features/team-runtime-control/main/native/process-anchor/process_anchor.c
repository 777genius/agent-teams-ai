#define _GNU_SOURCE
#include "process_anchor_protocol.h"
#include <dirent.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/prctl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#define PA_LAUNCH_FD 3
#define PA_EXECUTABLE_FD 4
#define PA_WORKDIR_FD 5
#define PA_PROVIDER_READY_FD 3
#define PA_EXIT_PROTOCOL 79
#define PA_EXIT_CLEANUP 80
#define PA_TARGET_CAPACITY PA_MAX_PROCESS_COUNT
#define PA_KILL_DRAIN_MS 5000U
#define PA_POLL_MS 10U
#define PA_PROVIDER_READY_FRAME "READY\n"
static volatile sig_atomic_t pa_parent_stop_requested = 0;
struct pa_process_identity {
  pid_t ppid;
  pid_t pgrp;
  unsigned long long start_time;
};
struct pa_classification {
  bool escaped_group;
  bool ambiguous_identity;
  bool process_limit;
};
struct pa_main_state {
  pid_t pid;
  int pidfd;
  bool exited;
  bool exit_reported;
  int wait_status;
};
static void pa_parent_stop(int signal_number) {
  (void)signal_number;
  pa_parent_stop_requested = 1;
}
static uint64_t pa_monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) == -1) return 0;
  return (uint64_t)now.tv_sec * 1000U + (uint64_t)now.tv_nsec / 1000000U;
}
static void pa_sleep_ms(unsigned milliseconds) {
  struct timespec delay = {
      .tv_sec = (time_t)(milliseconds / 1000U),
      .tv_nsec = (long)((milliseconds % 1000U) * 1000000U),
  };
  while (nanosleep(&delay, &delay) == -1 && errno == EINTR) {
  }
}
static int pa_write_all(int fd, const char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, bytes + offset, length - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (count == 0) return -1;
    offset += (size_t)count;
  }
  return 0;
}
static int pa_emit_suffix(const struct pa_launch *launch, uint64_t sequence,
                          const char *suffix) {
  char frame[PA_MAX_STATUS_BYTES + 1];
  int count = snprintf(
      frame, sizeof(frame),
      "{\"protocolVersion\":1,\"sequence\":%" PRIu64
      ",\"processRef\":\"%s\",\"teamId\":\"%s\",\"runId\":\"%s\""
      ",\"generation\":%" PRIu64 ",\"planHash\":\"%s\""
      ",\"executionUnitId\":\"%s\",\"spawnNonceDigest\":\"%s\""
      ",\"channelRef\":\"%s\"%s}\n",
      sequence, launch->process_ref, launch->team_id, launch->run_id, launch->generation,
      launch->plan_hash, launch->execution_unit_id, launch->spawn_nonce_digest,
      launch->channel_ref, suffix);
  if (count < 0 || (size_t)count >= sizeof(frame)) return -1;
  return pa_write_all(STDOUT_FILENO, frame, (size_t)count);
}
static int pa_emit_ready(const struct pa_launch *launch, uint64_t *sequence) {
  char suffix[PA_MAX_STATUS_BYTES / 2U];
  int count = snprintf(
      suffix, sizeof(suffix),
      ",\"type\":\"ready\",\"workspaceBinding\":{"
      "\"workspaceId\":\"%s\",\"registrationRevision\":%" PRIu64
      ",\"bindingGeneration\":%" PRIu64 ",\"mountGeneration\":%" PRIu64
      "},\"anchorIdentityRef\":\"%s\",\"mainProcessIdentityRef\":\"%s\"",
      launch->workspace.workspace_id, launch->workspace.registration_revision,
      launch->workspace.binding_generation, launch->workspace.mount_generation,
      launch->anchor_identity_ref, launch->main_process_identity_ref);
  if (count < 0 || (size_t)count >= sizeof(suffix)) return -1;
  *sequence = 1;
  return pa_emit_suffix(launch, *sequence, suffix);
}
static int pa_emit_main_exit(const struct pa_launch *launch, uint64_t *sequence,
                             int wait_status) {
  const char *outcome = "unknown";
  char suffix[128];
  if (WIFEXITED(wait_status)) outcome = WEXITSTATUS(wait_status) == 0 ? "success" : "failure";
  else if (WIFSIGNALED(wait_status)) outcome = "failure";
  (void)snprintf(suffix, sizeof(suffix), ",\"type\":\"main_exit\",\"outcome\":\"%s\"",
                 outcome);
  *sequence += 1;
  return pa_emit_suffix(launch, *sequence, suffix);
}
static int pa_emit_escalation(const struct pa_launch *launch, uint64_t *sequence,
                              const char *mode) {
  char suffix[96];
  (void)snprintf(suffix, sizeof(suffix), ",\"type\":\"escalation\",\"mode\":\"%s\"",
                 mode);
  *sequence += 1;
  return pa_emit_suffix(launch, *sequence, suffix);
}
static int pa_emit_protocol_error(const struct pa_launch *launch, uint64_t *sequence,
                                  const char *reason) {
  char suffix[384];
  (void)snprintf(suffix, sizeof(suffix),
                 ",\"type\":\"protocol_error\",\"reason\":\"%s\"", reason);
  *sequence += 1;
  return pa_emit_suffix(launch, *sequence, suffix);
}
static int pa_emit_terminal(const struct pa_launch *launch, uint64_t *sequence,
                            const struct pa_classification *classification,
                            size_t residual_count) {
  char suffix[1024];
  char residuals[384] = "";
  bool first = true;
#define PA_ADD_RESIDUAL(condition, label)                                      \
  do {                                                                          \
    if (condition) {                                                            \
      (void)strcat(residuals, first ? "\"" label "\"" : ",\"" label "\""); \
      first = false;                                                            \
    }                                                                           \
  } while (0)
  PA_ADD_RESIDUAL(classification->escaped_group, "escaped_group");
  PA_ADD_RESIDUAL(classification->ambiguous_identity, "ambiguous_identity");
  PA_ADD_RESIDUAL(classification->process_limit, "process_limit");
  PA_ADD_RESIDUAL(residual_count != 0, "live_descendant");
#undef PA_ADD_RESIDUAL
  *sequence += 1;
  if (first) {
    (void)snprintf(suffix, sizeof(suffix),
                   ",\"type\":\"drained\",\"outcome\":\"drained\",\"residuals\":[]");
  } else {
    (void)snprintf(
        suffix, sizeof(suffix),
        ",\"type\":\"unclassified_residual\",\"outcome\":\"unclassified\""
        ",\"residuals\":[%s],\"reason\":\"owned-tree-not-provably-drained\"",
        residuals);
  }
  return pa_emit_suffix(launch, *sequence, suffix);
}
static int pa_open_pidfd(pid_t pid) {
#ifdef SYS_pidfd_open
  return (int)syscall(SYS_pidfd_open, pid, 0U);
#else
  (void)pid;
  errno = ENOSYS;
  return -1;
#endif
}
static int pa_send_pidfd_signal(int pidfd, int signal_number) {
#ifdef SYS_pidfd_send_signal
  return (int)syscall(SYS_pidfd_send_signal, pidfd, signal_number, NULL, 0U);
#else
  (void)pidfd;
  (void)signal_number;
  errno = ENOSYS;
  return -1;
#endif
}
static bool pa_read_proc_identity(pid_t pid, struct pa_process_identity *identity) {
  char proc_path[64];
  char record[4096];
  char *command_end;
  char *save = NULL;
  char *field;
  size_t field_number = 3;
  bool have_ppid = false;
  bool have_pgrp = false;
  bool have_start_time = false;
  FILE *file;
  (void)snprintf(proc_path, sizeof(proc_path), "/proc/%ld/stat", (long)pid);
  file = fopen(proc_path, "r");
  if (file == NULL) return false;
  if (fgets(record, sizeof(record), file) == NULL) {
    (void)fclose(file);
    return false;
  }
  (void)fclose(file);
  command_end = strrchr(record, ')');
  if (command_end == NULL || command_end[1] != ' ') return false;
  field = strtok_r(command_end + 2, " ", &save);
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
    field_number += 1;
  }
  return have_ppid && have_pgrp && have_start_time;
}
static int pa_collect_descendants(pid_t anchor_pid, pid_t *output, size_t capacity,
                                  size_t *output_count) {
  pid_t known[PA_TARGET_CAPACITY + 1U];
  size_t known_count = 1;
  bool changed = true;
  known[0] = anchor_pid;
  while (changed) {
    DIR *proc;
    struct dirent *entry;
    changed = false;
    proc = opendir("/proc");
    if (proc == NULL) return -1;
    while ((entry = readdir(proc)) != NULL) {
      char *end = NULL;
      long candidate_long = strtol(entry->d_name, &end, 10);
      pid_t candidate;
      struct pa_process_identity identity;
      bool already_known = false;
      size_t index;
      if (end == entry->d_name || *end != '\0' || candidate_long <= 0) continue;
      candidate = (pid_t)candidate_long;
      for (index = 0; index < known_count; index++) {
        if (known[index] == candidate) {
          already_known = true;
          break;
        }
      }
      if (already_known || !pa_read_proc_identity(candidate, &identity)) continue;
      for (index = 0; index < known_count; index++) {
        if (known[index] != identity.ppid) continue;
        if (known_count >= PA_TARGET_CAPACITY + 1U) {
          (void)closedir(proc);
          return -2;
        }
        known[known_count++] = candidate;
        changed = true;
        break;
      }
    }
    (void)closedir(proc);
  }
  *output_count = 0;
  for (size_t index = 1; index < known_count; index++) {
    if (*output_count >= capacity) return -2;
    output[(*output_count)++] = known[index];
  }
  return 0;
}
static size_t pa_signal_descendants(pid_t anchor_pid, pid_t owned_pgrp,
                                    struct pa_main_state *main_state, int signal_number,
                                    uint64_t max_process_count,
                                    struct pa_classification *classification) {
  pid_t descendants[PA_TARGET_CAPACITY];
  size_t count = 0;
  int collect = pa_collect_descendants(anchor_pid, descendants, PA_TARGET_CAPACITY, &count);
  if (collect == -1) classification->ambiguous_identity = true;
  if (collect == -2 || count > max_process_count) classification->process_limit = true;
  if (!main_state->exited && main_state->pidfd >= 0) {
    if (pa_send_pidfd_signal(main_state->pidfd, signal_number) == -1 && errno != ESRCH)
      classification->ambiguous_identity = true;
  }
  for (size_t index = 0; index < count; index++) {
    struct pa_process_identity before;
    struct pa_process_identity after;
    int pidfd;
    if (descendants[index] == main_state->pid) continue;
    if (!pa_read_proc_identity(descendants[index], &before)) continue;
    pidfd = pa_open_pidfd(descendants[index]);
    if (pidfd == -1) {
      if (errno != ESRCH) classification->ambiguous_identity = true;
      continue;
    }
    if (!pa_read_proc_identity(descendants[index], &after)) {
      (void)close(pidfd);
      continue;
    }
    if (before.ppid != after.ppid || before.pgrp != after.pgrp ||
        before.start_time != after.start_time) {
      classification->ambiguous_identity = true;
      (void)close(pidfd);
      continue;
    }
    if (after.pgrp != owned_pgrp) {
      classification->escaped_group = true;
      (void)close(pidfd);
      continue;
    }
    if (pa_send_pidfd_signal(pidfd, signal_number) == -1 && errno != ESRCH)
      classification->ambiguous_identity = true;
    (void)close(pidfd);
  }
  return count;
}
static int pa_reap_available(const struct pa_launch *launch, struct pa_main_state *main_state,
                             uint64_t *sequence) {
  int wait_status;
  pid_t reaped;
  while ((reaped = waitpid(-1, &wait_status, WNOHANG)) > 0) {
    if (reaped != main_state->pid) continue;
    main_state->exited = true;
    main_state->wait_status = wait_status;
    if (!main_state->exit_reported) {
      if (pa_emit_main_exit(launch, sequence, wait_status) == -1) return -1;
      main_state->exit_reported = true;
    }
  }
  return 0;
}
static int pa_close_provider_descriptors(int handoff_fd) {
  DIR *directory = opendir("/proc/self/fd");
  int descriptors[4096];
  size_t count = 0;
  int directory_fd;
  struct dirent *entry;
  if (directory == NULL) return -1;
  directory_fd = dirfd(directory);
  while ((entry = readdir(directory)) != NULL) {
    char *end = NULL;
    long descriptor = strtol(entry->d_name, &end, 10);
    if (end == entry->d_name || *end != '\0' || descriptor < 3 ||
        descriptor == PA_EXECUTABLE_FD || descriptor == handoff_fd ||
        descriptor == directory_fd)
      continue;
    if (count >= sizeof(descriptors) / sizeof(descriptors[0])) {
      (void)closedir(directory);
      return -1;
    }
    descriptors[count++] = (int)descriptor;
  }
  (void)closedir(directory);
  for (size_t index = 0; index < count; index++) (void)close(descriptors[index]);
  return 0;
}
static char **pa_build_environment(const struct pa_launch *launch) {
  char **environment = calloc(launch->envc + 1U, sizeof(*environment));
  if (environment == NULL) return NULL;
  for (size_t index = 0; index < launch->envc; index++) {
    size_t name_length = strlen(launch->environment[index].name);
    size_t value_length = strlen(launch->environment[index].value);
    environment[index] = malloc(name_length + value_length + 2U);
    if (environment[index] == NULL) {
      for (size_t cleanup = 0; cleanup < index; cleanup++) free(environment[cleanup]);
      free(environment);
      return NULL;
    }
    (void)snprintf(environment[index], name_length + value_length + 2U, "%s=%s",
                   launch->environment[index].name, launch->environment[index].value);
  }
  return environment;
}
static void pa_free_environment(char **environment) {
  if (environment == NULL) return;
  for (size_t index = 0; environment[index] != NULL; index++) free(environment[index]);
  free(environment);
}
static int pa_wait_main_exact(struct pa_main_state *main_state) {
  int wait_status;
  pid_t reaped;
  if (main_state->pid <= 0 || main_state->exited) return 0;
  do {
    reaped = waitpid(main_state->pid, &wait_status, 0);
  } while (reaped == -1 && errno == EINTR);
  if (reaped != main_state->pid) return -1;
  main_state->exited = true;
  main_state->wait_status = wait_status;
  return 0;
}
static int pa_reap_remaining_children(void) {
  int wait_status;
  pid_t reaped;
  do {
    reaped = waitpid(-1, &wait_status, 0);
  } while (reaped > 0 || (reaped == -1 && errno == EINTR));
  return reaped == -1 && errno == ECHILD ? 0 : -1;
}
static int pa_terminate_and_reap_main(struct pa_main_state *main_state, int gate_fd) {
  int result = 0;
  if (gate_fd >= 0 && close(gate_fd) == -1 && errno != EBADF) result = -1;
  if (!main_state->exited && main_state->pidfd >= 0 &&
      pa_send_pidfd_signal(main_state->pidfd, SIGKILL) == -1 && errno != ESRCH)
    result = -1;
  if (pa_wait_main_exact(main_state) == -1) result = -1;
  if (pa_reap_remaining_children() == -1) result = -1;
  if (main_state->pidfd >= 0) {
    if (close(main_state->pidfd) == -1) result = -1;
    main_state->pidfd = -1;
  }
  return result;
}
static int pa_read_start_gate(int descriptor) {
  char value;
  ssize_t count;
  do {
    count = read(descriptor, &value, 1);
  } while (count == -1 && errno == EINTR);
  return count == 1 && value == 'G' ? 0 : -1;
}
static int pa_read_exec_handoff(int descriptor) {
  char failure;
  ssize_t count;
  do {
    count = read(descriptor, &failure, 1);
  } while (count == -1 && errno == EINTR);
  return count == 0 ? 0 : -1;
}
static void pa_exit_like_provider(int wait_status) {
  if (WIFEXITED(wait_status)) _exit(WEXITSTATUS(wait_status));
  if (WIFSIGNALED(wait_status)) {
    struct sigaction default_action = {.sa_handler = SIG_DFL};
    (void)sigemptyset(&default_action.sa_mask);
    (void)sigaction(WTERMSIG(wait_status), &default_action, NULL);
    (void)raise(WTERMSIG(wait_status));
  }
  _exit(127);
}
static void pa_run_provider_bootstrap(char **arguments, char **environment) {
  struct sigaction default_action = {.sa_handler = SIG_DFL};
  struct sigaction ignore_action = {.sa_handler = SIG_IGN};
  int handoff_pipe[2] = {-1, -1};
  pid_t expected_parent = getpid();
  pid_t provider;
  int wait_status;
  if (pipe2(handoff_pipe, O_CLOEXEC) == -1) _exit(125);
  provider = fork();
  if (provider == 0) {
    (void)close(handoff_pipe[0]);
    (void)sigemptyset(&default_action.sa_mask);
    (void)sigaction(SIGTERM, &default_action, NULL);
    (void)sigaction(SIGINT, &default_action, NULL);
    (void)sigaction(SIGHUP, &default_action, NULL);
    (void)sigaction(SIGPIPE, &default_action, NULL);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) == -1 ||
        getppid() != expected_parent ||
        pa_close_provider_descriptors(handoff_pipe[1]) == -1)
      _exit(125);
#ifdef SYS_execveat
    (void)syscall(SYS_execveat, PA_EXECUTABLE_FD, "", arguments, environment, AT_EMPTY_PATH);
#endif
    (void)pa_write_all(handoff_pipe[1], "F", 1);
    _exit(126);
  }
  (void)close(handoff_pipe[1]);
  (void)close(PA_EXECUTABLE_FD);
  free(arguments);
  pa_free_environment(environment);
  if (provider <= 0 || pa_read_exec_handoff(handoff_pipe[0]) == -1) {
    (void)close(handoff_pipe[0]);
    _exit(126);
  }
  (void)close(handoff_pipe[0]);
  if (pa_write_all(PA_PROVIDER_READY_FD, PA_PROVIDER_READY_FRAME,
                   strlen(PA_PROVIDER_READY_FRAME)) == -1 ||
      close(PA_PROVIDER_READY_FD) == -1)
    _exit(125);
  (void)sigemptyset(&ignore_action.sa_mask);
  (void)sigaction(SIGTERM, &ignore_action, NULL);
  (void)sigaction(SIGINT, &ignore_action, NULL);
  (void)sigaction(SIGHUP, &ignore_action, NULL);
  while (waitpid(provider, &wait_status, 0) == -1) {
    if (errno != EINTR) _exit(127);
  }
  pa_exit_like_provider(wait_status);
}
static int pa_spawn_main(const struct pa_launch *launch, struct pa_main_state *main_state,
                         int *provider_ready_fd) {
  char **arguments = calloc(launch->argc + 2U, sizeof(*arguments));
  char **environment = pa_build_environment(launch);
  int ready_pipe[2] = {-1, -1};
  int gate_pipe[2] = {-1, -1};
  pid_t expected_parent = getpid();
  pid_t child;
  if (arguments == NULL || environment == NULL || pipe2(ready_pipe, O_CLOEXEC) == -1 ||
      pipe2(gate_pipe, O_CLOEXEC) == -1) {
    free(arguments);
    pa_free_environment(environment);
    if (ready_pipe[0] >= 0) (void)close(ready_pipe[0]);
    if (ready_pipe[1] >= 0) (void)close(ready_pipe[1]);
    if (gate_pipe[0] >= 0) (void)close(gate_pipe[0]);
    if (gate_pipe[1] >= 0) (void)close(gate_pipe[1]);
    return -1;
  }
  arguments[0] = launch->executable_path;
  for (size_t index = 0; index < launch->argc; index++) arguments[index + 1U] = launch->argv[index];
  child = fork();
  if (child == 0) {
    int null_fd;
    (void)close(ready_pipe[0]);
    (void)close(gate_pipe[1]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) == -1 ||
        getppid() != expected_parent || pa_read_start_gate(gate_pipe[0]) == -1)
      _exit(125);
    (void)close(gate_pipe[0]);
    if (setpgid(0, 0) == -1 || fchdir(PA_WORKDIR_FD) == -1 ||
        fcntl(PA_EXECUTABLE_FD, F_SETFD, FD_CLOEXEC) == -1)
      _exit(125);
    null_fd = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (null_fd == -1 || dup2(null_fd, STDIN_FILENO) == -1 ||
        dup2(null_fd, STDOUT_FILENO) == -1 || dup2(null_fd, STDERR_FILENO) == -1)
      _exit(125);
    if (null_fd > STDERR_FILENO) (void)close(null_fd);
    if (ready_pipe[1] != PA_PROVIDER_READY_FD) {
      if (dup2(ready_pipe[1], PA_PROVIDER_READY_FD) == -1) _exit(125);
      (void)close(ready_pipe[1]);
    }
    (void)close(PA_WORKDIR_FD);
    pa_run_provider_bootstrap(arguments, environment);
  }
  (void)close(PA_EXECUTABLE_FD);
  (void)close(PA_WORKDIR_FD);
  (void)close(ready_pipe[1]);
  (void)close(gate_pipe[0]);
  free(arguments);
  pa_free_environment(environment);
  if (child <= 0) {
    (void)close(ready_pipe[0]);
    (void)close(gate_pipe[1]);
    return -1;
  }
  main_state->pid = child;
  main_state->pidfd = pa_open_pidfd(child);
  if (main_state->pidfd == -1 || fcntl(main_state->pidfd, F_SETFD, FD_CLOEXEC) == -1 ||
      (setpgid(child, child) == -1 && errno != EACCES && errno != ESRCH) ||
      pa_write_all(gate_pipe[1], "G", 1) == -1) {
    int cleanup_result;
    (void)close(ready_pipe[0]);
    cleanup_result = pa_terminate_and_reap_main(main_state, gate_pipe[1]);
    return cleanup_result == 0 ? -1 : -2;
  }
  (void)close(gate_pipe[1]);
  *provider_ready_fd = ready_pipe[0];
  return 0;
}
static int pa_wait_provider_ready(int descriptor, struct pa_main_state *main_state,
                                  uint64_t maximum_wait_ms) {
  char frame[sizeof(PA_PROVIDER_READY_FRAME)];
  size_t used = 0;
  uint64_t started_at = pa_monotonic_ms();
  for (;;) {
    struct pollfd descriptors[2] = {
        {.fd = descriptor, .events = POLLIN | POLLHUP},
        {.fd = STDIN_FILENO, .events = POLLIN | POLLHUP},
    };
    int wait_status;
    pid_t reaped;
    int ready;
    do {
      reaped = waitpid(main_state->pid, &wait_status, WNOHANG);
    } while (reaped == -1 && errno == EINTR);
    if (reaped == main_state->pid) {
      main_state->exited = true;
      main_state->wait_status = wait_status;
      return -1;
    }
    if (reaped == -1 || pa_parent_stop_requested ||
        pa_monotonic_ms() - started_at >= maximum_wait_ms)
      return -1;
    ready = poll(descriptors, 2, (int)PA_POLL_MS);
    if (ready < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (ready == 0) continue;
    if ((descriptors[1].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0) return -1;
    if ((descriptors[0].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0) {
      ssize_t count;
      do {
        count = read(descriptor, frame + used, sizeof(frame) - used);
      } while (count == -1 && errno == EINTR);
      if (count < 0 || (count > 0 && used + (size_t)count >= sizeof(frame))) return -1;
      if (count > 0) {
        used += (size_t)count;
        continue;
      }
      return used == strlen(PA_PROVIDER_READY_FRAME) &&
                     memcmp(frame, PA_PROVIDER_READY_FRAME, used) == 0
                 ? 0
                 : -1;
    }
  }
}
static int pa_control_valid_for_launch(const struct pa_control *control,
                                       const struct pa_launch *launch) {
  if (!pa_control_matches_launch(control, launch)) return 0;
  if (strcmp(control->mode, "immediate") == 0) return control->grace_ms == 0;
  return control->grace_ms <= launch->graceful_stop_ms;
}
static int pa_read_control(const struct pa_launch *launch, struct pa_control *control) {
  char bytes[PA_MAX_CONTROL_BYTES + 1U];
  int count = pa_read_frame(STDIN_FILENO, bytes, sizeof(bytes), 0);
  if (count <= 0) return count;
  if (pa_parse_control(bytes, (size_t)count, control) == -1 ||
      !pa_control_valid_for_launch(control, launch)) {
    pa_free_control(control);
    return -1;
  }
  return 1;
}
static int pa_check_repeated_control(const struct pa_launch *launch,
                                     const struct pa_control *first_control) {
  struct pollfd descriptor = {.fd = STDIN_FILENO, .events = POLLIN | POLLHUP};
  int ready = poll(&descriptor, 1, 0);
  if (ready <= 0 || (descriptor.revents & POLLIN) == 0) return 0;
  {
    struct pa_control repeated;
    int result = pa_read_control(launch, &repeated);
    if (result <= 0) return result < 0 ? -1 : 0;
    result = pa_controls_equal(first_control, &repeated) ? 0 : -1;
    pa_free_control(&repeated);
    return result;
  }
}
static size_t pa_count_descendants(struct pa_classification *classification) {
  pid_t descendants[PA_TARGET_CAPACITY];
  size_t count = 0;
  int result = pa_collect_descendants(getpid(), descendants, PA_TARGET_CAPACITY, &count);
  if (result == -1) classification->ambiguous_identity = true;
  if (result == -2) classification->process_limit = true;
  return count;
}
static int pa_drain(const struct pa_launch *launch, struct pa_main_state *main_state,
                    pid_t owned_pgrp, const struct pa_control *first_control,
                    bool immediate, uint64_t grace_ms, uint64_t *sequence,
                    struct pa_classification *classification, size_t *residual_count) {
  uint64_t phase_start = pa_monotonic_ms();
  if (!immediate) {
    if (pa_emit_escalation(launch, sequence, "term") == -1) return -1;
    for (;;) {
      (void)pa_signal_descendants(getpid(), owned_pgrp, main_state, SIGTERM,
                                  launch->max_process_count, classification);
      if (pa_reap_available(launch, main_state, sequence) == -1) return -1;
      if (first_control != NULL && pa_check_repeated_control(launch, first_control) == -1)
        return -2;
      *residual_count = pa_count_descendants(classification);
      if (*residual_count == 0 || pa_monotonic_ms() - phase_start >= grace_ms) break;
      pa_sleep_ms(PA_POLL_MS);
    }
  }
  *residual_count = pa_count_descendants(classification);
  if (immediate || grace_ms == 0 || *residual_count != 0) {
    if (pa_emit_escalation(launch, sequence, "kill") == -1) return -1;
    phase_start = pa_monotonic_ms();
    do {
      (void)pa_signal_descendants(getpid(), owned_pgrp, main_state, SIGKILL,
                                  launch->max_process_count, classification);
      if (pa_reap_available(launch, main_state, sequence) == -1) return -1;
      if (first_control != NULL && pa_check_repeated_control(launch, first_control) == -1)
        return -2;
      *residual_count = pa_count_descendants(classification);
      if (*residual_count == 0) break;
      pa_sleep_ms(PA_POLL_MS);
    } while (pa_monotonic_ms() - phase_start < PA_KILL_DRAIN_MS);
  }
  if (pa_reap_available(launch, main_state, sequence) == -1) return -1;
  *residual_count = pa_count_descendants(classification);
  return 0;
}
int main(void) {
  char launch_bytes[PA_MAX_LAUNCH_BYTES + 1U];
  struct pa_launch launch;
  struct pa_main_state main_state = {.pid = -1, .pidfd = -1};
  struct pa_classification classification = {0};
  struct pa_control stop_control;
  struct pa_control *first_control = NULL;
  struct sigaction stop_action = {.sa_handler = pa_parent_stop};
  struct sigaction ignore_action = {.sa_handler = SIG_IGN};
  uint64_t sequence = 0;
  uint64_t ready_at;
  uint64_t grace_ms = 0;
  size_t residual_count = 0;
  const char *protocol_error_reason = "invalid-control-frame";
  bool immediate = false;
  bool protocol_failure = false;
  pid_t expected_parent = getppid();
  int provider_ready_fd = -1;
  int launch_count;
  struct stat executable_stat;
  struct stat workdir_stat;
  (void)sigemptyset(&stop_action.sa_mask);
  (void)sigemptyset(&ignore_action.sa_mask);
  if (sigaction(SIGTERM, &stop_action, NULL) == -1 ||
      sigaction(SIGINT, &stop_action, NULL) == -1 ||
      sigaction(SIGHUP, &stop_action, NULL) == -1 ||
      sigaction(SIGPIPE, &ignore_action, NULL) == -1 ||
      prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0) == -1 ||
      prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == -1 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == -1 || getppid() != expected_parent)
    return PA_EXIT_PROTOCOL;
  launch_count = pa_read_frame(PA_LAUNCH_FD, launch_bytes, sizeof(launch_bytes), 1);
  (void)close(PA_LAUNCH_FD);
  if (launch_count <= 0 ||
      pa_parse_launch(launch_bytes, (size_t)launch_count, &launch) == -1)
    return PA_EXIT_PROTOCOL;
  if (fstat(PA_EXECUTABLE_FD, &executable_stat) == -1 ||
      !S_ISREG(executable_stat.st_mode) || fstat(PA_WORKDIR_FD, &workdir_stat) == -1 ||
      !S_ISDIR(workdir_stat.st_mode) || pa_parent_stop_requested ||
      pa_spawn_main(&launch, &main_state, &provider_ready_fd) != 0) {
    if (provider_ready_fd >= 0) (void)close(provider_ready_fd);
    pa_free_launch(&launch);
    return PA_EXIT_PROTOCOL;
  }
  if (pa_wait_provider_ready(provider_ready_fd, &main_state, launch.max_runtime_ms) == -1) {
    int cleanup_result;
    (void)close(provider_ready_fd);
    cleanup_result = pa_terminate_and_reap_main(&main_state, -1);
    pa_free_launch(&launch);
    return cleanup_result == 0 ? PA_EXIT_PROTOCOL : PA_EXIT_CLEANUP;
  }
  (void)close(provider_ready_fd);
  if (pa_emit_ready(&launch, &sequence) == -1) {
    int cleanup_result = pa_terminate_and_reap_main(&main_state, -1);
    pa_free_launch(&launch);
    return cleanup_result == 0 ? PA_EXIT_PROTOCOL : PA_EXIT_CLEANUP;
  }
  ready_at = pa_monotonic_ms();
  for (;;) {
    struct pollfd control_descriptor = {.fd = STDIN_FILENO, .events = POLLIN | POLLHUP};
    int ready;
    if (pa_reap_available(&launch, &main_state, &sequence) == -1) {
      protocol_failure = true;
      break;
    }
    if (main_state.exited || pa_parent_stop_requested ||
        pa_monotonic_ms() - ready_at >= launch.max_runtime_ms) {
      grace_ms = launch.graceful_stop_ms;
      break;
    }
    if (pa_count_descendants(&classification) > launch.max_process_count) {
      classification.process_limit = true;
      grace_ms = 0;
      immediate = true;
      break;
    }
    ready = poll(&control_descriptor, 1, (int)PA_POLL_MS);
    if (ready < 0) {
      if (errno == EINTR) continue;
      protocol_failure = true;
      break;
    }
    if (ready == 0) continue;
    if ((control_descriptor.revents & POLLIN) != 0) {
      int result = pa_read_control(&launch, &stop_control);
      if (result == 1) {
        first_control = &stop_control;
        immediate = strcmp(stop_control.mode, "immediate") == 0;
        grace_ms = stop_control.grace_ms;
        break;
      }
      if (result < 0) protocol_failure = true;
      else grace_ms = launch.graceful_stop_ms;
      break;
    }
    if ((control_descriptor.revents & (POLLHUP | POLLERR | POLLNVAL)) != 0) {
      grace_ms = launch.graceful_stop_ms;
      break;
    }
  }
  {
    int drain = pa_drain(&launch, &main_state, main_state.pid, first_control,
                         protocol_failure ? false : immediate,
                         protocol_failure ? 0 : grace_ms, &sequence, &classification,
                         &residual_count);
    if (drain == -2 && !protocol_failure) {
      protocol_failure = true;
      protocol_error_reason = "mismatched-repeated-control";
      (void)pa_drain(&launch, &main_state, main_state.pid, NULL, true, 0, &sequence,
                     &classification, &residual_count);
    } else if (drain == -1) {
      protocol_failure = true;
    }
  }
  if (protocol_failure)
    (void)pa_emit_protocol_error(&launch, &sequence, protocol_error_reason);
  else
    (void)pa_emit_terminal(&launch, &sequence, &classification, residual_count);
  if (first_control != NULL) pa_free_control(first_control);
  if (main_state.pidfd >= 0) (void)close(main_state.pidfd);
  pa_free_launch(&launch);
  return protocol_failure ? PA_EXIT_PROTOCOL : 0;
}
