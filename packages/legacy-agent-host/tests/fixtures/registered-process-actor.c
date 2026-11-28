#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <pthread.h>
#endif
static volatile sig_atomic_t stopped = 0;
static char release[PATH_MAX], changed[PATH_MAX], closed[PATH_MAX];
static double deadline;
static void stop(int signal) { (void)signal; stopped = 1; }
static double now(void) { struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) exit(2); return t.tv_sec + t.tv_nsec / 1e9; }
static int run_actor(void) {
  int drifted = 0;
  while (!stopped && now() < deadline) {
    if (!drifted && access(release, F_OK) == 0) {
      if (setsid() != getpid()) return 3;
      FILE *file = fopen(changed, "wx"); if (!file) return 4;
      fprintf(file, "{\"pid\":%d,\"sid\":%d}\n", getpid(), getsid(0)); fclose(file); drifted = 1;
    }
    usleep(10000);
  }
  FILE *file = fopen(closed, "wx"); if (!file) return 4;
  fprintf(file, "{\"pid\":%d,\"reason\":\"%s\"}\n", getpid(), stopped ? "SIGTERM" : "natural-ttl"); fclose(file);
  return 0;
}
#ifdef __linux__
static int worker_result;
static void *worker(void *unused) { (void)unused; worker_result = run_actor(); return NULL; }
#endif
int main(int argc, char **argv) {
  if (argc != 3 || (strncmp(argv[1], "/private/tmp/TEST-", 18) != 0 && strncmp(argv[1], "/tmp/TEST-", 10) != 0) ||
      strspn(argv[2], "abcdefghijklmnopqrstuvwxyz") != strlen(argv[2])) return 2;
  if (snprintf(release, sizeof(release), "%s/%s.drift", argv[1], argv[2]) >= (int)sizeof(release) ||
      snprintf(changed, sizeof(changed), "%s/%s.did-drift", argv[1], argv[2]) >= (int)sizeof(changed) ||
      snprintf(closed, sizeof(closed), "%s/%s.closed", argv[1], argv[2]) >= (int)sizeof(closed)) return 2;
  umask(0077); signal(SIGTERM, stop);
  printf("{\"pid\":%d}\n", getpid()); fflush(stdout);
  deadline = now() + 12;
#ifdef __linux__
  if (strcmp(argv[2], "leader") == 0) {
    char thread_exit[PATH_MAX]; pthread_t thread;
    if (snprintf(thread_exit, sizeof(thread_exit), "%s/%s.thread-exit", argv[1], argv[2]) >= (int)sizeof(thread_exit) ||
        pthread_create(&thread, NULL, worker, NULL) != 0) return 5;
    while (!stopped && now() < deadline && access(thread_exit, F_OK) != 0) usleep(10000);
    if (access(thread_exit, F_OK) == 0) pthread_exit(NULL);
    if (pthread_join(thread, NULL) != 0) return 5;
    return worker_result;
  }
#endif
  return run_actor();
}
