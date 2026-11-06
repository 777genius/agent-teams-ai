#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
static volatile sig_atomic_t stopped = 0;
static void stop(int signal) { (void)signal; stopped = 1; }
static double now(void) { struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) exit(2); return t.tv_sec + t.tv_nsec / 1e9; }
int main(int argc, char **argv) {
  char release[PATH_MAX], changed[PATH_MAX], closed[PATH_MAX];
  if (argc != 3 || strncmp(argv[1], "/private/tmp/TEST-", 18) != 0 ||
      strspn(argv[2], "abcdefghijklmnopqrstuvwxyz") != strlen(argv[2])) return 2;
  if (snprintf(release, sizeof(release), "%s/%s.drift", argv[1], argv[2]) >= (int)sizeof(release) ||
      snprintf(changed, sizeof(changed), "%s/%s.did-drift", argv[1], argv[2]) >= (int)sizeof(changed) ||
      snprintf(closed, sizeof(closed), "%s/%s.closed", argv[1], argv[2]) >= (int)sizeof(closed)) return 2;
  umask(0077); signal(SIGTERM, stop);
  printf("{\"pid\":%d}\n", getpid()); fflush(stdout);
  const double deadline = now() + 12; int drifted = 0;
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
