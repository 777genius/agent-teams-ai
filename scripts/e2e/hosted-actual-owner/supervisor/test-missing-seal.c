#define _GNU_SOURCE
/* Link ONLY into a separate test ELF. Pretend F_ADD_SEALS succeeded without sealing;
 * the production helper must discover the real kernel F_GET_SEALS result and refuse exec. */
#include <fcntl.h>
#include <stdarg.h>
int __real_fcntl(int fd, int command, ...);
int __wrap_fcntl(int fd, int command, ...) {
  if (command == F_GETFL || command == F_GETFD || command == F_GET_SEALS)
    return __real_fcntl(fd, command);
  va_list args; va_start(args, command); int value = va_arg(args, int); va_end(args);
  if (command == F_ADD_SEALS) return 0;
  return __real_fcntl(fd, command, value);
}
