/*
 * relay-secrets: the only program on relay's keychain items' access list.
 *
 *   relay-secrets get <name>     print the item's value on stdout
 *   relay-secrets set <name>     create the item from stdin; never replaces one
 *   relay-secrets status <name>  print missing, relay-only (readable by this
 *                                build alone) or shared (anything else)
 *
 * `relay install-service` compiles this into <RELAY_HOME>/bin/relay-secrets
 * and signs it ad hoc. `set` creates each item with an access list holding
 * only this binary, so `security find-generic-password -w` from any other
 * program raises a keychain dialog in the operator's GUI session instead of
 * answering.
 *
 * Threat model. `get` answers only when its direct parent is the running
 * relay daemon: the parent's pid must be the one the daemon writes to
 * <RELAY_HOME>/run/relay-daemon.pid at startup (and removes at exit), and
 * the parent's executable must be the node binary baked in at build time
 * (RELAY_NODE_PATH), so a shell that writes its own pid there is still
 * refused. The pid file is found next to this binary, never through the
 * environment, so a worker cannot point the helper at a file of its own. It
 * is not a boundary against a same-user process that rewrites the pid file
 * and runs the helper from its own node, rewrites the binary, or attaches to
 * the daemon: relay's self-protection is a narrowing (plan user decision 7,
 * named under Risks). `set` never replaces an existing item, so a worker
 * cannot swap the receipt key or a token for one it knows. `status` prints
 * no secret; that its probe read never raises a dialog on the file-based
 * login keychain is UNVERIFIED (see command_status).
 *
 * The access list pins this binary's code signature, so rebuilding it makes
 * existing items prompt again; `relay secrets migrate` recreates them.
 */
#define __STDC_WANT_LIB_EXT1__ 1
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <libgen.h>
#include <libproc.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define EXIT_USAGE 64
#define EXIT_NOT_FOUND 66
#define EXIT_EXISTS 73
#define EXIT_REFUSED 77
#define EXIT_FAILED 1
#define MAX_VALUE_BYTES 65536
#define ACCOUNT "relay"

#ifndef RELAY_NODE_PATH
#error "build with -DRELAY_NODE_PATH=\"<the daemon's node binary>\"; relay install-service does"
#endif

/* out must hold PATH_MAX bytes, as realpath requires. */
static int self_path(char out[PATH_MAX]) {
  char raw[PATH_MAX];
  uint32_t raw_size = sizeof(raw);
  if (_NSGetExecutablePath(raw, &raw_size) != 0) return -1;
  return realpath(raw, out) == NULL ? -1 : 0;
}

/* <RELAY_HOME>/bin/relay-secrets -> <RELAY_HOME>/run/relay-daemon.pid */
static int daemon_pid(pid_t *pid) {
  char self[PATH_MAX];
  if (self_path(self) != 0) return -1;
  char bin_dir[PATH_MAX];
  strlcpy(bin_dir, dirname(self), sizeof(bin_dir));
  char home[PATH_MAX];
  strlcpy(home, dirname(bin_dir), sizeof(home));
  char pid_file[PATH_MAX];
  if (snprintf(pid_file, sizeof(pid_file), "%s/run/relay-daemon.pid", home) >= (int)sizeof(pid_file)) return -1;

  FILE *file = fopen(pid_file, "r");
  if (file == NULL) return -1;
  char line[32] = {0};
  char *read = fgets(line, sizeof(line), file);
  fclose(file);
  if (read == NULL) return -1;
  char *end = NULL;
  errno = 0;
  long value = strtol(line, &end, 10);
  if (errno != 0 || end == line || (*end != '\n' && *end != '\0') || value <= 1) return -1;
  *pid = (pid_t)value;
  return 0;
}

static CFMutableDictionaryRef item_query(const char *name) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFStringRef service = CFStringCreateWithCString(NULL, name, kCFStringEncodingUTF8);
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, service);
  CFRelease(service);
  return query;
}

/* The parent's executable, resolved, must be the daemon's node binary. */
static int parent_is_daemon_node(void) {
  char parent[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath(getppid(), parent, sizeof(parent)) <= 0) return 0;
  char resolved[PATH_MAX];
  if (realpath(parent, resolved) == NULL) return 0;
  return strcmp(resolved, RELAY_NODE_PATH) == 0;
}

static int command_get(const char *name) {
  pid_t expected = 0;
  if (daemon_pid(&expected) != 0 || getppid() != expected || !parent_is_daemon_node()) {
    fprintf(stderr, "relay-secrets: refused, the caller is not the relay daemon\n");
    return EXIT_REFUSED;
  }
  CFMutableDictionaryRef query = item_query(name);
  CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching(query, &result);
  CFRelease(query);
  if (status == errSecItemNotFound) return EXIT_NOT_FOUND;
  if (status != errSecSuccess || result == NULL) return EXIT_FAILED;
  CFDataRef data = (CFDataRef)result;
  size_t written = fwrite(CFDataGetBytePtr(data), 1, (size_t)CFDataGetLength(data), stdout);
  int ok = written == (size_t)CFDataGetLength(data) && fflush(stdout) == 0;
  CFRelease(result);
  return ok ? 0 : EXIT_FAILED;
}

static int command_set(const char *name) {
  static unsigned char value[MAX_VALUE_BYTES + 1];
  size_t length = fread(value, 1, sizeof(value), stdin);
  if (length == 0 || length > MAX_VALUE_BYTES) {
    fprintf(stderr, "relay-secrets: the value on stdin must be 1 to %d bytes\n", MAX_VALUE_BYTES);
    return EXIT_USAGE;
  }

  char self[PATH_MAX];
  SecTrustedApplicationRef trusted = NULL;
  if (self_path(self) != 0 || SecTrustedApplicationCreateFromPath(self, &trusted) != errSecSuccess) return EXIT_FAILED;
  CFArrayRef trusted_list = CFArrayCreate(NULL, (const void **)&trusted, 1, &kCFTypeArrayCallBacks);
  CFStringRef label = CFStringCreateWithCString(NULL, name, kCFStringEncodingUTF8);
  SecAccessRef access = NULL;
  OSStatus status = SecAccessCreate(label, trusted_list, &access);
  CFRelease(trusted_list);
  CFRelease(trusted);
  if (status != errSecSuccess) {
    CFRelease(label);
    return EXIT_FAILED;
  }

  CFMutableDictionaryRef attributes = item_query(name);
  CFStringRef account = CFStringCreateWithCString(NULL, ACCOUNT, kCFStringEncodingUTF8);
  CFDataRef data = CFDataCreate(NULL, value, (CFIndex)length);
  CFDictionarySetValue(attributes, kSecAttrAccount, account);
  CFDictionarySetValue(attributes, kSecAttrLabel, label);
  CFDictionarySetValue(attributes, kSecValueData, data);
  CFDictionarySetValue(attributes, kSecAttrAccess, access);
  status = SecItemAdd(attributes, NULL);
  memset_s(value, sizeof(value), 0, sizeof(value)); /* not elided, unlike memset */
  CFRelease(data);
  CFRelease(account);
  CFRelease(label);
  CFRelease(access);
  CFRelease(attributes);
  if (status == errSecDuplicateItem) {
    fprintf(stderr, "relay-secrets: %s already exists and is never replaced by this helper\n", name);
    return EXIT_EXISTS;
  }
  return status == errSecSuccess ? 0 : EXIT_FAILED;
}

/* relay-only when every decrypt ACL names exactly this binary and nothing else. */
static int command_status(const char *name) {
  CFMutableDictionaryRef query = item_query(name);
  CFDictionarySetValue(query, kSecReturnRef, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef item = NULL;
  OSStatus status = SecItemCopyMatching(query, &item);
  CFRelease(query);
  if (status == errSecItemNotFound) {
    printf("missing\n");
    return 0;
  }
  if (status != errSecSuccess || item == NULL) return EXIT_FAILED;

  SecAccessRef access = NULL;
  status = SecKeychainItemCopyAccess((SecKeychainItemRef)item, &access);
  CFRelease(item);
  if (status != errSecSuccess) return EXIT_FAILED;
  CFArrayRef acls = SecAccessCopyMatchingACLList(access, kSecACLAuthorizationDecrypt);
  CFRelease(access);
  if (acls == NULL) return EXIT_FAILED;

  char self[PATH_MAX];
  if (self_path(self) != 0) {
    CFRelease(acls);
    return EXIT_FAILED;
  }
  int relay_only = CFArrayGetCount(acls) > 0;
  for (CFIndex i = 0; relay_only && i < CFArrayGetCount(acls); i++) {
    CFArrayRef apps = NULL;
    CFStringRef description = NULL;
    SecKeychainPromptSelector selector = 0;
    if (SecACLCopyContents((SecACLRef)CFArrayGetValueAtIndex(acls, i), &apps, &description, &selector) != errSecSuccess) {
      relay_only = 0;
      break;
    }
    if (description != NULL) CFRelease(description);
    /* A NULL application list means any application may read the item. */
    if (apps == NULL || CFArrayGetCount(apps) == 0) relay_only = 0;
    for (CFIndex j = 0; relay_only && apps != NULL && j < CFArrayGetCount(apps); j++) {
      CFDataRef app_data = NULL;
      if (SecTrustedApplicationCopyData((SecTrustedApplicationRef)CFArrayGetValueAtIndex(apps, j), &app_data) != errSecSuccess || app_data == NULL) {
        relay_only = 0;
        break;
      }
      const char *app_path = (const char *)CFDataGetBytePtr(app_data);
      size_t app_length = (size_t)CFDataGetLength(app_data);
      while (app_length > 0 && app_path[app_length - 1] == '\0') app_length--;
      if (app_length != strlen(self) || strncmp(app_path, self, app_length) != 0) relay_only = 0;
      CFRelease(app_data);
    }
    if (apps != NULL) CFRelease(apps);
  }
  CFRelease(acls);
  /*
   * The access list pins a code signature, not only the path checked above,
   * so a rebuilt helper is no longer trusted. Prove this build can read the
   * item; the value is discarded, never printed. UNVERIFIED: that
   * kSecUseAuthenticationUIFail stops the legacy file-keychain ACL dialog
   * here, rather than only data-protection keychain UI. If it does not, an
   * operator running status on a stale item sees a dialog and must deny it.
   */
  if (relay_only) {
    CFMutableDictionaryRef probe = item_query(name);
    CFDictionarySetValue(probe, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(probe, kSecMatchLimit, kSecMatchLimitOne);
    CFDictionarySetValue(probe, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
    CFTypeRef data = NULL;
    if (SecItemCopyMatching(probe, &data) != errSecSuccess) relay_only = 0;
    if (data != NULL) CFRelease(data);
    CFRelease(probe);
  }
  printf(relay_only ? "relay-only\n" : "shared\n");
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3 || argv[2][0] == '\0') {
    fprintf(stderr, "usage: relay-secrets get|set|status <name>\n");
    return EXIT_USAGE;
  }
  if (strcmp(argv[1], "get") == 0) return command_get(argv[2]);
  if (strcmp(argv[1], "set") == 0) return command_set(argv[2]);
  if (strcmp(argv[1], "status") == 0) return command_status(argv[2]);
  fprintf(stderr, "usage: relay-secrets get|set|status <name>\n");
  return EXIT_USAGE;
}
