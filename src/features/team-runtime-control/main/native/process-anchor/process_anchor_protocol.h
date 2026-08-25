#ifndef AGENT_TEAMS_PROCESS_ANCHOR_PROTOCOL_H
#define AGENT_TEAMS_PROCESS_ANCHOR_PROTOCOL_H

#include <ctype.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define PA_PROTOCOL_VERSION 1
#define PA_MAX_LAUNCH_BYTES (512U * 1024U)
#define PA_MAX_CONTROL_BYTES 4096U
#define PA_MAX_STATUS_BYTES 4096U
#define PA_MAX_ARGC 256U
#define PA_MAX_ENVC 256U
#define PA_MAX_PROCESS_COUNT 1024U
#define PA_MAX_PATH_BYTES 4096U
#define PA_MAX_ID_BYTES 256U
#define PA_MAX_ARG_BYTES (64U * 1024U)
#define PA_MAX_ENV_BYTES (256U * 1024U)

struct pa_workspace_binding {
  char *workspace_id;
  uint64_t registration_revision;
  uint64_t binding_generation;
  uint64_t mount_generation;
  uint64_t registered_device;
  uint64_t registered_inode;
  uint64_t registered_mount_id;
};

struct pa_environment_entry {
  char *name;
  char *value;
};

struct pa_launch {
  uint64_t protocol_version;
  char *process_ref;
  char *team_id;
  char *run_id;
  uint64_t generation;
  char *plan_hash;
  char *execution_unit_id;
  char *spawn_nonce_digest;
  char *channel_ref;
  struct pa_workspace_binding workspace;
  char *anchor_identity_ref;
  char *main_process_identity_ref;
  char *executable_path;
  char *argv[PA_MAX_ARGC];
  size_t argc;
  char *workdir_path;
  struct pa_environment_entry environment[PA_MAX_ENVC];
  size_t envc;
  uint64_t max_runtime_ms;
  uint64_t graceful_stop_ms;
  uint64_t max_process_count;
};

struct pa_control {
  uint64_t protocol_version;
  char *type;
  uint64_t sequence;
  char *process_ref;
  char *team_id;
  char *run_id;
  uint64_t generation;
  char *plan_hash;
  char *execution_unit_id;
  char *mode;
  uint64_t grace_ms;
};

struct pa_json_cursor {
  const char *bytes;
  size_t length;
  size_t offset;
  unsigned depth;
};

static void pa_free_launch(struct pa_launch *launch) {
  size_t index;
  free(launch->process_ref);
  free(launch->team_id);
  free(launch->run_id);
  free(launch->plan_hash);
  free(launch->execution_unit_id);
  free(launch->spawn_nonce_digest);
  free(launch->channel_ref);
  free(launch->workspace.workspace_id);
  free(launch->anchor_identity_ref);
  free(launch->main_process_identity_ref);
  free(launch->executable_path);
  for (index = 0; index < launch->argc; index++) free(launch->argv[index]);
  free(launch->workdir_path);
  for (index = 0; index < launch->envc; index++) {
    free(launch->environment[index].name);
    free(launch->environment[index].value);
  }
  memset(launch, 0, sizeof(*launch));
}

static void pa_free_control(struct pa_control *control) {
  free(control->type);
  free(control->process_ref);
  free(control->team_id);
  free(control->run_id);
  free(control->plan_hash);
  free(control->execution_unit_id);
  free(control->mode);
  memset(control, 0, sizeof(*control));
}

static int pa_read_frame(int fd, char *buffer, size_t capacity, int require_eof) {
  size_t used = 0;
  for (;;) {
    char byte;
    ssize_t count = read(fd, &byte, 1);
    if (count == 0) return used == 0 ? 0 : -1;
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (byte == '\n') break;
    if (byte == '\r' || used + 1 >= capacity) return -1;
    buffer[used++] = byte;
  }
  if (used == 0) return -1;
  buffer[used] = '\0';
  if (require_eof) {
    char trailing;
    ssize_t count;
    do {
      count = read(fd, &trailing, 1);
    } while (count < 0 && errno == EINTR);
    if (count != 0) return -1;
  }
  return (int)used;
}

static void pa_json_whitespace(struct pa_json_cursor *cursor) {
  while (cursor->offset < cursor->length) {
    char value = cursor->bytes[cursor->offset];
    if (value != ' ' && value != '\t' && value != '\n' && value != '\r') break;
    cursor->offset++;
  }
}

static int pa_json_take(struct pa_json_cursor *cursor, char expected) {
  pa_json_whitespace(cursor);
  if (cursor->offset >= cursor->length || cursor->bytes[cursor->offset] != expected) return -1;
  cursor->offset++;
  return 0;
}

static int pa_hex_digit(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

static int pa_parse_hex_quad(struct pa_json_cursor *cursor, uint32_t *result) {
  uint32_t value = 0;
  unsigned index;
  for (index = 0; index < 4; index++) {
    int digit;
    if (cursor->offset >= cursor->length) return -1;
    digit = pa_hex_digit(cursor->bytes[cursor->offset++]);
    if (digit < 0) return -1;
    value = (value << 4U) | (uint32_t)digit;
  }
  *result = value;
  return 0;
}

static int pa_append_utf8(char *output, size_t capacity, size_t *used, uint32_t codepoint) {
  unsigned char encoded[4];
  size_t count;
  if (codepoint == 0 || codepoint > 0x10ffffU ||
      (codepoint >= 0xd800U && codepoint <= 0xdfffU))
    return -1;
  if (codepoint <= 0x7fU) {
    encoded[0] = (unsigned char)codepoint;
    count = 1;
  } else if (codepoint <= 0x7ffU) {
    encoded[0] = (unsigned char)(0xc0U | (codepoint >> 6U));
    encoded[1] = (unsigned char)(0x80U | (codepoint & 0x3fU));
    count = 2;
  } else if (codepoint <= 0xffffU) {
    encoded[0] = (unsigned char)(0xe0U | (codepoint >> 12U));
    encoded[1] = (unsigned char)(0x80U | ((codepoint >> 6U) & 0x3fU));
    encoded[2] = (unsigned char)(0x80U | (codepoint & 0x3fU));
    count = 3;
  } else {
    encoded[0] = (unsigned char)(0xf0U | (codepoint >> 18U));
    encoded[1] = (unsigned char)(0x80U | ((codepoint >> 12U) & 0x3fU));
    encoded[2] = (unsigned char)(0x80U | ((codepoint >> 6U) & 0x3fU));
    encoded[3] = (unsigned char)(0x80U | (codepoint & 0x3fU));
    count = 4;
  }
  if (*used + count >= capacity) return -1;
  memcpy(output + *used, encoded, count);
  *used += count;
  return 0;
}

static int pa_json_string(struct pa_json_cursor *cursor, char **result, size_t maximum) {
  char *output;
  size_t used = 0;
  if (pa_json_take(cursor, '"') < 0) return -1;
  output = calloc(maximum + 1, 1);
  if (output == NULL) return -1;
  while (cursor->offset < cursor->length) {
    unsigned char value = (unsigned char)cursor->bytes[cursor->offset++];
    if (value == '"') {
      output[used] = '\0';
      *result = output;
      return 0;
    }
    if (value < 0x20U) break;
    if (value != '\\') {
      if (used >= maximum) break;
      output[used++] = (char)value;
      continue;
    }
    if (cursor->offset >= cursor->length) break;
    value = (unsigned char)cursor->bytes[cursor->offset++];
    if (value == '"' || value == '\\' || value == '/') {
      if (used >= maximum) break;
      output[used++] = (char)value;
    } else if (value == 'b' || value == 'f' || value == 'n' || value == 'r' || value == 't') {
      static const char escaped[] = {'\b', '\f', '\n', '\r', '\t'};
      static const char names[] = {'b', 'f', 'n', 'r', 't', '\0'};
      const char *position = strchr(names, (int)value);
      if (used >= maximum || position == NULL) break;
      output[used++] = escaped[position - names];
    } else if (value == 'u') {
      uint32_t first;
      if (pa_parse_hex_quad(cursor, &first) < 0) break;
      if (first >= 0xd800U && first <= 0xdbffU) {
        uint32_t second;
        if (cursor->offset + 2 > cursor->length || cursor->bytes[cursor->offset] != '\\' ||
            cursor->bytes[cursor->offset + 1] != 'u')
          break;
        cursor->offset += 2;
        if (pa_parse_hex_quad(cursor, &second) < 0 || second < 0xdc00U || second > 0xdfffU) break;
        first = 0x10000U + ((first - 0xd800U) << 10U) + (second - 0xdc00U);
      } else if (first >= 0xdc00U && first <= 0xdfffU) {
        break;
      }
      if (pa_append_utf8(output, maximum + 1, &used, first) < 0) break;
    } else {
      break;
    }
  }
  free(output);
  return -1;
}

static int pa_json_uint(struct pa_json_cursor *cursor, uint64_t *result) {
  uint64_t value = 0;
  size_t start;
  pa_json_whitespace(cursor);
  start = cursor->offset;
  if (start >= cursor->length || !isdigit((unsigned char)cursor->bytes[start])) return -1;
  if (cursor->bytes[start] == '0' && start + 1 < cursor->length &&
      isdigit((unsigned char)cursor->bytes[start + 1]))
    return -1;
  while (cursor->offset < cursor->length &&
         isdigit((unsigned char)cursor->bytes[cursor->offset])) {
    unsigned digit = (unsigned)(cursor->bytes[cursor->offset++] - '0');
    if (value > (UINT64_MAX - digit) / 10U) return -1;
    value = value * 10U + digit;
  }
  *result = value;
  return cursor->offset > start ? 0 : -1;
}

/* Descriptor identities are encoded as decimal strings so JavaScript never rounds uint64 values. */
static int pa_json_uint_string(struct pa_json_cursor *cursor, uint64_t *result) {
  uint64_t value = 0;
  size_t start;
  if (pa_json_take(cursor, '"') < 0) return -1;
  start = cursor->offset;
  if (start >= cursor->length || !isdigit((unsigned char)cursor->bytes[start])) return -1;
  if (cursor->bytes[start] == '0' && start + 1 < cursor->length &&
      isdigit((unsigned char)cursor->bytes[start + 1]))
    return -1;
  while (cursor->offset < cursor->length &&
         isdigit((unsigned char)cursor->bytes[cursor->offset])) {
    unsigned digit = (unsigned)(cursor->bytes[cursor->offset++] - '0');
    if (value > (UINT64_MAX - digit) / 10U) return -1;
    value = value * 10U + digit;
  }
  if (cursor->offset == start || pa_json_take(cursor, '"') < 0) return -1;
  *result = value;
  return 0;
}

static int pa_json_object_next(struct pa_json_cursor *cursor, int *first, char **key) {
  pa_json_whitespace(cursor);
  if (cursor->offset < cursor->length && cursor->bytes[cursor->offset] == '}') {
    cursor->offset++;
    return 0;
  }
  if (!*first && pa_json_take(cursor, ',') < 0) return -1;
  *first = 0;
  if (pa_json_string(cursor, key, 64) < 0 || pa_json_take(cursor, ':') < 0) return -1;
  return 1;
}

static int pa_parse_workspace(struct pa_json_cursor *cursor, struct pa_workspace_binding *value) {
  uint32_t seen = 0;
  int first = 1;
  if (pa_json_take(cursor, '{') < 0) return -1;
  for (;;) {
    char *key = NULL;
    int next = pa_json_object_next(cursor, &first, &key);
    int result = 0;
    uint32_t bit = 0;
    if (next <= 0) return next < 0 || seen != 0x7fU ? -1 : 0;
    if (strcmp(key, "workspaceId") == 0) {
      bit = 1U << 0;
      result = pa_json_string(cursor, &value->workspace_id, PA_MAX_ID_BYTES);
    } else if (strcmp(key, "registrationRevision") == 0) {
      bit = 1U << 1;
      result = pa_json_uint(cursor, &value->registration_revision);
    } else if (strcmp(key, "bindingGeneration") == 0) {
      bit = 1U << 2;
      result = pa_json_uint(cursor, &value->binding_generation);
    } else if (strcmp(key, "mountGeneration") == 0) {
      bit = 1U << 3;
      result = pa_json_uint(cursor, &value->mount_generation);
    } else if (strcmp(key, "registeredDevice") == 0) {
      bit = 1U << 4;
      result = pa_json_uint_string(cursor, &value->registered_device);
    } else if (strcmp(key, "registeredInode") == 0) {
      bit = 1U << 5;
      result = pa_json_uint_string(cursor, &value->registered_inode);
    } else if (strcmp(key, "registeredMountId") == 0) {
      bit = 1U << 6;
      result = pa_json_uint_string(cursor, &value->registered_mount_id);
    } else {
      result = -1;
    }
    free(key);
    if (result < 0 || (seen & bit) != 0) return -1;
    seen |= bit;
  }
}

static int pa_parse_argv(struct pa_json_cursor *cursor, struct pa_launch *launch) {
  int first = 1;
  size_t total = 0;
  if (pa_json_take(cursor, '[') < 0) return -1;
  for (;;) {
    char *argument = NULL;
    size_t length;
    pa_json_whitespace(cursor);
    if (cursor->offset < cursor->length && cursor->bytes[cursor->offset] == ']') {
      cursor->offset++;
      return 0;
    }
    if (!first && pa_json_take(cursor, ',') < 0) return -1;
    first = 0;
    if (launch->argc >= PA_MAX_ARGC ||
        pa_json_string(cursor, &argument, PA_MAX_ARG_BYTES) < 0)
      return -1;
    length = strlen(argument);
    total += length;
    if (total > 256U * 1024U) {
      free(argument);
      return -1;
    }
    launch->argv[launch->argc++] = argument;
  }
}

static int pa_valid_environment_name(const char *name) {
  const unsigned char *cursor = (const unsigned char *)name;
  if (!(*cursor == '_' || isalpha(*cursor))) return 0;
  cursor++;
  while (*cursor != '\0') {
    if (!(*cursor == '_' || isalnum(*cursor))) return 0;
    cursor++;
  }
  return 1;
}

static int pa_parse_environment_entry(struct pa_json_cursor *cursor,
                                      struct pa_environment_entry *entry) {
  uint32_t seen = 0;
  int first = 1;
  if (pa_json_take(cursor, '{') < 0) return -1;
  for (;;) {
    char *key = NULL;
    int next = pa_json_object_next(cursor, &first, &key);
    int result = 0;
    uint32_t bit = 0;
    if (next <= 0) {
      if (next < 0 || seen != 3U || !pa_valid_environment_name(entry->name)) return -1;
      return 0;
    }
    if (strcmp(key, "name") == 0) {
      bit = 1U;
      result = pa_json_string(cursor, &entry->name, 255);
    } else if (strcmp(key, "value") == 0) {
      bit = 2U;
      result = pa_json_string(cursor, &entry->value, PA_MAX_ARG_BYTES);
    } else {
      result = -1;
    }
    free(key);
    if (result < 0 || (seen & bit) != 0) return -1;
    seen |= bit;
  }
}

static int pa_parse_environment(struct pa_json_cursor *cursor, struct pa_launch *launch) {
  int first = 1;
  size_t total = 0;
  if (pa_json_take(cursor, '[') < 0) return -1;
  for (;;) {
    size_t index;
    pa_json_whitespace(cursor);
    if (cursor->offset < cursor->length && cursor->bytes[cursor->offset] == ']') {
      cursor->offset++;
      return 0;
    }
    if (!first && pa_json_take(cursor, ',') < 0) return -1;
    first = 0;
    if (launch->envc >= PA_MAX_ENVC ||
        pa_parse_environment_entry(cursor, &launch->environment[launch->envc]) < 0)
      return -1;
    for (index = 0; index < launch->envc; index++) {
      if (strcmp(launch->environment[index].name,
                 launch->environment[launch->envc].name) == 0)
        return -1;
    }
    total += strlen(launch->environment[launch->envc].name) + 1U +
             strlen(launch->environment[launch->envc].value);
    if (total > PA_MAX_ENV_BYTES) return -1;
    launch->envc++;
  }
}

static int pa_is_sha256(const char *value) {
  size_t index;
  if (strlen(value) != 71U || strncmp(value, "sha256:", 7U) != 0) return 0;
  for (index = 7; index < 71U; index++) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f')))
      return 0;
  }
  return 1;
}

static int pa_parse_launch(const char *bytes, size_t length, struct pa_launch *launch) {
  struct pa_json_cursor cursor = {bytes, length, 0, 0};
  uint32_t seen = 0;
  int first = 1;
  memset(launch, 0, sizeof(*launch));
  if (pa_json_take(&cursor, '{') < 0) return -1;
  for (;;) {
    char *key = NULL;
    int next = pa_json_object_next(&cursor, &first, &key);
    int result = 0;
    uint32_t bit = 0;
    if (next <= 0) {
      pa_json_whitespace(&cursor);
      if (next < 0 || seen != 0x7ffffU || cursor.offset != cursor.length) goto invalid;
      break;
    }
#define PA_LAUNCH_STRING(name, member, index, maximum)     \
  if (strcmp(key, name) == 0) {                            \
    bit = 1U << index;                                     \
    result = pa_json_string(&cursor, &launch->member, maximum); \
  }
    PA_LAUNCH_STRING("processRef", process_ref, 1, PA_MAX_ID_BYTES)
    else PA_LAUNCH_STRING("teamId", team_id, 2, PA_MAX_ID_BYTES)
    else PA_LAUNCH_STRING("runId", run_id, 3, PA_MAX_ID_BYTES)
    else PA_LAUNCH_STRING("planHash", plan_hash, 5, PA_MAX_ID_BYTES)
    else PA_LAUNCH_STRING("executionUnitId", execution_unit_id, 6, PA_MAX_ID_BYTES)
    else PA_LAUNCH_STRING("spawnNonceDigest", spawn_nonce_digest, 7, PA_MAX_ID_BYTES)
    else PA_LAUNCH_STRING("channelRef", channel_ref, 8, PA_MAX_ID_BYTES)
    else PA_LAUNCH_STRING("anchorIdentityRef", anchor_identity_ref, 10, PA_MAX_ID_BYTES)
    else PA_LAUNCH_STRING("mainProcessIdentityRef", main_process_identity_ref, 11,
                          PA_MAX_ID_BYTES)
    else PA_LAUNCH_STRING("executablePath", executable_path, 12, PA_MAX_PATH_BYTES)
    else PA_LAUNCH_STRING("workdirPath", workdir_path, 14, PA_MAX_PATH_BYTES)
    else if (strcmp(key, "protocolVersion") == 0) {
      bit = 1U << 0;
      result = pa_json_uint(&cursor, &launch->protocol_version);
    } else if (strcmp(key, "generation") == 0) {
      bit = 1U << 4;
      result = pa_json_uint(&cursor, &launch->generation);
    } else if (strcmp(key, "workspaceBinding") == 0) {
      bit = 1U << 9;
      result = pa_parse_workspace(&cursor, &launch->workspace);
    } else if (strcmp(key, "argv") == 0) {
      bit = 1U << 13;
      result = pa_parse_argv(&cursor, launch);
    } else if (strcmp(key, "environment") == 0) {
      bit = 1U << 15;
      result = pa_parse_environment(&cursor, launch);
    } else if (strcmp(key, "maxRuntimeMs") == 0) {
      bit = 1U << 16;
      result = pa_json_uint(&cursor, &launch->max_runtime_ms);
    } else if (strcmp(key, "gracefulStopMs") == 0) {
      bit = 1U << 17;
      result = pa_json_uint(&cursor, &launch->graceful_stop_ms);
    } else if (strcmp(key, "maxProcessCount") == 0) {
      bit = 1U << 18;
      result = pa_json_uint(&cursor, &launch->max_process_count);
    } else {
      result = -1;
    }
#undef PA_LAUNCH_STRING
    free(key);
    if (result < 0 || bit == 0 || (seen & bit) != 0) goto invalid;
    seen |= bit;
  }
  if (launch->protocol_version != PA_PROTOCOL_VERSION || launch->generation == 0 ||
      launch->workspace.registration_revision == 0 || launch->workspace.binding_generation == 0 ||
      launch->workspace.mount_generation == 0 || launch->workspace.registered_inode == 0 ||
      launch->workspace.registered_mount_id == 0 || launch->max_runtime_ms == 0 ||
      launch->max_process_count == 0 || launch->max_process_count > PA_MAX_PROCESS_COUNT ||
      launch->executable_path[0] != '/' || launch->workdir_path[0] != '/' ||
      !pa_is_sha256(launch->plan_hash) || !pa_is_sha256(launch->spawn_nonce_digest))
    goto invalid;
  return 0;
invalid:
  pa_free_launch(launch);
  return -1;
}

static int pa_parse_control(const char *bytes, size_t length, struct pa_control *control) {
  struct pa_json_cursor cursor = {bytes, length, 0, 0};
  uint32_t seen = 0;
  int first = 1;
  memset(control, 0, sizeof(*control));
  if (pa_json_take(&cursor, '{') < 0) return -1;
  for (;;) {
    char *key = NULL;
    int next = pa_json_object_next(&cursor, &first, &key);
    int result = 0;
    uint32_t bit = 0;
    if (next <= 0) {
      pa_json_whitespace(&cursor);
      if (next < 0 || seen != 0x7ffU || cursor.offset != cursor.length) goto invalid;
      break;
    }
#define PA_CONTROL_STRING(name, member, index)                      \
  if (strcmp(key, name) == 0) {                                    \
    bit = 1U << index;                                              \
    result = pa_json_string(&cursor, &control->member, PA_MAX_ID_BYTES); \
  }
    PA_CONTROL_STRING("type", type, 1)
    else PA_CONTROL_STRING("processRef", process_ref, 3)
    else PA_CONTROL_STRING("teamId", team_id, 4)
    else PA_CONTROL_STRING("runId", run_id, 5)
    else PA_CONTROL_STRING("planHash", plan_hash, 7)
    else PA_CONTROL_STRING("executionUnitId", execution_unit_id, 8)
    else PA_CONTROL_STRING("mode", mode, 9)
    else if (strcmp(key, "protocolVersion") == 0) {
      bit = 1U << 0;
      result = pa_json_uint(&cursor, &control->protocol_version);
    } else if (strcmp(key, "sequence") == 0) {
      bit = 1U << 2;
      result = pa_json_uint(&cursor, &control->sequence);
    } else if (strcmp(key, "generation") == 0) {
      bit = 1U << 6;
      result = pa_json_uint(&cursor, &control->generation);
    } else if (strcmp(key, "graceMs") == 0) {
      bit = 1U << 10;
      result = pa_json_uint(&cursor, &control->grace_ms);
    } else {
      result = -1;
    }
#undef PA_CONTROL_STRING
    free(key);
    if (result < 0 || bit == 0 || (seen & bit) != 0) goto invalid;
    seen |= bit;
  }
  if (control->protocol_version != PA_PROTOCOL_VERSION || control->sequence == 0 ||
      control->generation == 0 || strcmp(control->type, "stop") != 0 ||
      (strcmp(control->mode, "graceful") != 0 && strcmp(control->mode, "immediate") != 0) ||
      !pa_is_sha256(control->plan_hash))
    goto invalid;
  return 0;
invalid:
  pa_free_control(control);
  return -1;
}

static int pa_control_matches_launch(const struct pa_control *control,
                                     const struct pa_launch *launch) {
  return control->protocol_version == launch->protocol_version &&
         strcmp(control->process_ref, launch->process_ref) == 0 &&
         strcmp(control->team_id, launch->team_id) == 0 &&
         strcmp(control->run_id, launch->run_id) == 0 &&
         control->generation == launch->generation &&
         strcmp(control->plan_hash, launch->plan_hash) == 0 &&
         strcmp(control->execution_unit_id, launch->execution_unit_id) == 0;
}

static int pa_controls_equal(const struct pa_control *left, const struct pa_control *right) {
  return left->sequence == right->sequence && left->grace_ms == right->grace_ms &&
         strcmp(left->mode, right->mode) == 0 &&
         strcmp(left->process_ref, right->process_ref) == 0 &&
         strcmp(left->team_id, right->team_id) == 0 && strcmp(left->run_id, right->run_id) == 0 &&
         left->generation == right->generation && strcmp(left->plan_hash, right->plan_hash) == 0 &&
         strcmp(left->execution_unit_id, right->execution_unit_id) == 0;
}

#endif
