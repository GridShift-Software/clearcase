/* Test shim for tests/e2e/pilot/durability.mjs (S42 backwards clock, LIMIT-DEADLINE), ported from the hardened
 * pilot prototype (spikes/pilot-hardened/app/tests/shim/clockshift.c). An LD_PRELOAD library that shifts
 * CLOCK_REALTIME (and gettimeofday) by the number of seconds read from the file named by $CLOCK_SHIFT_FILE on
 * every call, so a running server's wall clock can be moved backwards or forwards between two requests.
 * Monotonic clocks are untouched. No variable, no file or an empty file means no shift.
 * Compiled on demand into the run's temp root: cc -shared -fPIC -O2 -o clockshift.so clockshift.c -ldl */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static long long shift_ns(void) {
	const char *p = getenv("CLOCK_SHIFT_FILE");
	if (!p) return 0;
	int fd = open(p, O_RDONLY | O_CLOEXEC);
	if (fd < 0) return 0;
	char b[64];
	ssize_t n = read(fd, b, sizeof b - 1);
	close(fd);
	if (n <= 0) return 0;
	b[n] = 0;
	return (long long)(strtod(b, NULL) * 1e9);
}

static void shift(long long *s, long long *ns) {
	long long t = *s * 1000000000LL + *ns + shift_ns();
	*s = t / 1000000000LL;
	*ns = t % 1000000000LL;
	if (*ns < 0) { *ns += 1000000000LL; *s -= 1; }
}

int clock_gettime(clockid_t c, struct timespec *ts) {
	static int (*real)(clockid_t, struct timespec *);
	if (!real) real = (int (*)(clockid_t, struct timespec *))dlsym(RTLD_NEXT, "clock_gettime");
	int r = real(c, ts);
	if (r == 0 && (c == CLOCK_REALTIME || c == CLOCK_REALTIME_COARSE)) {
		long long s = ts->tv_sec, ns = ts->tv_nsec;
		shift(&s, &ns);
		ts->tv_sec = s;
		ts->tv_nsec = ns;
	}
	return r;
}

int gettimeofday(struct timeval *tv, void *tz) {
	static int (*real)(struct timeval *, void *);
	if (!real) real = (int (*)(struct timeval *, void *))dlsym(RTLD_NEXT, "gettimeofday");
	int r = real(tv, tz);
	if (r == 0 && tv) {
		long long s = tv->tv_sec, ns = (long long)tv->tv_usec * 1000LL;
		shift(&s, &ns);
		tv->tv_sec = s;
		tv->tv_usec = ns / 1000LL;
	}
	return r;
}
