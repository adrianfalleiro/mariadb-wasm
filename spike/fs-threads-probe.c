// Second feasibility question: can background threads do real, durable file
// I/O under Emscripten?
//
// InnoDB's page cleaner and log writer write and fsync from background threads,
// and the datadir has to survive process exit or the whole thing is a toy.
// Emscripten's default MEMFS is in-memory and would satisfy neither. This
// probe uses NODERAWFS (real paths straight through to Node's fs) and does the
// writes from spawned threads, not from main.
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>

#define N_WRITERS 3
#define ROWS_PER_WRITER 500

static const char *dir;

typedef struct { long id; int ok; } writer_arg;

static void *writer(void *p) {
  writer_arg *a = (writer_arg *) p;
  char path[512];
  snprintf(path, sizeof path, "%s/thread-%ld.dat", dir, a->id);

  int fd = open(path, O_CREAT | O_TRUNC | O_WRONLY, 0644);
  if (fd < 0) { printf("  thread %ld: open failed: %s\n", a->id, strerror(errno)); return NULL; }

  for (int i = 0; i < ROWS_PER_WRITER; i++) {
    char buf[64];
    int n = snprintf(buf, sizeof buf, "%ld:%d\n", a->id, i);
    if (write(fd, buf, n) != n) { printf("  thread %ld: short write\n", a->id); close(fd); return NULL; }
  }

  // Durability barrier, as InnoDB does on log flush.
  if (fsync(fd) != 0) { printf("  thread %ld: fsync failed: %s\n", a->id, strerror(errno)); close(fd); return NULL; }
  close(fd);

  // Read back from the same thread.
  fd = open(path, O_RDONLY);
  if (fd < 0) { printf("  thread %ld: reopen failed\n", a->id); return NULL; }
  char first[32] = {0};
  ssize_t got = read(fd, first, 8);
  close(fd);
  if (got <= 0) { printf("  thread %ld: readback failed\n", a->id); return NULL; }

  a->ok = 1;
  printf("  thread %ld: wrote+fsynced %d rows, readback starts %.*s\n",
         a->id, ROWS_PER_WRITER, 3, first);
  return NULL;
}

int main(int argc, char **argv) {
  if (argc < 2) { printf("RESULT: FAIL (no dir arg)\n"); return 1; }
  dir = argv[1];

  pthread_t t[N_WRITERS];
  writer_arg args[N_WRITERS];

  for (long i = 0; i < N_WRITERS; i++) {
    args[i].id = i; args[i].ok = 0;
    if (pthread_create(&t[i], NULL, writer, &args[i]) != 0) {
      printf("RESULT: FAIL pthread_create\n");
      return 1;
    }
  }
  for (int i = 0; i < N_WRITERS; i++) pthread_join(t[i], NULL);

  int ok = 0;
  for (int i = 0; i < N_WRITERS; i++) ok += args[i].ok;
  printf("RESULT: %s (%d/%d writers)\n", ok == N_WRITERS ? "PASS" : "FAIL", ok, N_WRITERS);
  return ok == N_WRITERS ? 0 : 1;
}
