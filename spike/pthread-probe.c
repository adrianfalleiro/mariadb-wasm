// Does Emscripten's pthread support handle InnoDB's actual threading shape?
//
// InnoDB does not just spawn threads — its background workers (log writer, log
// flusher, page cleaner, purge coordinator) park on condition variables with
// timed waits and are woken by other threads, and shutdown joins them all.
// That is the pattern that has to work, not a trivial spawn-and-join.
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>

#define N_WORKERS 4
#define WORK_ITEMS 2000

static pthread_mutex_t mtx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t work_cv = PTHREAD_COND_INITIALIZER;
static pthread_cond_t done_cv = PTHREAD_COND_INITIALIZER;

static int queued;
static int processed;
static int shutting_down;
static int timed_waits_observed;

static void *worker(void *arg) {
  long id = (long) arg;
  for (;;) {
    pthread_mutex_lock(&mtx);
    while (queued == 0 && !shutting_down) {
      // Timed wait, as InnoDB's background threads use.
      struct timespec ts;
      clock_gettime(CLOCK_REALTIME, &ts);
      ts.tv_nsec += 20 * 1000 * 1000; // 20ms
      if (ts.tv_nsec >= 1000000000L) { ts.tv_sec++; ts.tv_nsec -= 1000000000L; }
      if (pthread_cond_timedwait(&work_cv, &mtx, &ts) == ETIMEDOUT)
        timed_waits_observed++;
    }
    if (shutting_down && queued == 0) {
      pthread_mutex_unlock(&mtx);
      break;
    }
    queued--;
    processed++;
    if (processed == WORK_ITEMS) pthread_cond_signal(&done_cv);
    pthread_mutex_unlock(&mtx);
  }
  printf("  worker %ld exiting\n", id);
  return NULL;
}

int main(void) {
  pthread_t threads[N_WORKERS];

  for (long i = 0; i < N_WORKERS; i++) {
    if (pthread_create(&threads[i], NULL, worker, (void *) i) != 0) {
      printf("RESULT: FAIL pthread_create (%s)\n", strerror(errno));
      return 1;
    }
  }

  for (int i = 0; i < WORK_ITEMS; i++) {
    pthread_mutex_lock(&mtx);
    queued++;
    pthread_cond_signal(&work_cv);
    pthread_mutex_unlock(&mtx);
  }

  pthread_mutex_lock(&mtx);
  while (processed < WORK_ITEMS)
    pthread_cond_wait(&done_cv, &mtx);
  pthread_mutex_unlock(&mtx);

  // Idle phase: with no work queued, every worker must fall through to the
  // 20ms pthread_cond_timedwait timeout and loop. This is how InnoDB's
  // background threads spend almost all of their time, so ETIMEDOUT working
  // correctly matters more than the busy path above.
  struct timespec idle = {0, 300 * 1000 * 1000}; // 300ms
  nanosleep(&idle, NULL);

  pthread_mutex_lock(&mtx);
  shutting_down = 1;
  pthread_cond_broadcast(&work_cv);
  pthread_mutex_unlock(&mtx);

  for (int i = 0; i < N_WORKERS; i++)
    pthread_join(threads[i], NULL);

  printf("processed=%d timed_waits=%d\n", processed, timed_waits_observed);
  printf("RESULT: %s\n", processed == WORK_ITEMS ? "PASS" : "FAIL");
  return processed == WORK_ITEMS ? 0 : 1;
}
