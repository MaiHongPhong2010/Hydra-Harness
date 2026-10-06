/** Simulate terminal handles for the assembled launcher, with ordinary pipe input. */
for (const stream of [process.stdin, process.stdout]) {
  Object.defineProperty(stream, 'isTTY', { value: process.env.HYDRA_INSTALL_TEST_TTY !== '0' })
}
