/**
 * The wordmark, for a person at a terminal.
 *
 * Only to a terminal wide enough to hold it. In a pipe, journald or `docker logs` it is twelve
 * lines of noise, and in a narrow window it wraps into worse noise.
 *
 * The top line keeps the terminal's own text color, so it reads on light and dark themes alike;
 * TRACKING is RAL 6018 Yellow green, as in docs/social-preview.png. NO_COLOR turns that off.
 */
const TOP = [
  '█▀█▄  █▀█  █▀█▀█▀█        █▀█▀█▀▄   ▄▀█▀█▀▄        ▀▀█▀█▀▀  ▀█▀█▀  █▀█▀█▀█▀█  █▀█▀█▀█',
  '████▄ ███  ███ ███        ███ ███   ███ ▀▀▀          ███     ███   ███ █ ███  ███ ▀▀▀',
  '███▀█▄███  ███ ███        ███▀▀█▀▄  █▄███▀█          ███     ███   ███   ███  ███▀',
  '███ ▀████  ███ ███        ███  ███  ▄▄▄ ███          ███     ███   ███   ███  ███ ▄▄▄',
  '███  ▀███  ███▄███        ███▄▄██▀  ▀██▄██▀          ███    ▄███▄  ███   ███  ███▄███',
];

const BOTTOM = [
  '      ▀▀█▀█▀▀  █▀█▀█▀▄   █▀█▀█▀█  █▀█▀█▀█  █▀█  █▀█  ▀█▀█▀  █▀█▄  █▀█  ▄▀█▀▀█▀▄',
  '        ███    ███ ███   ███ ███  ███ ▀▀▀  ███ ▄▀▀▀   ███   ████▄ ███  ███  ▀▀▀',
  '        ███    ███▀▀█▄   ███▀███  ███      ███▀■▄▄▄   ███   ███▀█▄███  ███',
  '        ███    ███  ███  ███ ███  ███ ▄▄▄  ███  ███   ███   ███ ▀████  ███ ▄▄▄▄',
  '        ███    ███  ███  ███ ███  ███▄███  ███  ███  ▄███▄  ███  ▀███  ▀██▄▄███',
];

const GREEN = '\x1b[38;2;96;153;59m';
const RESET = '\x1b[0m';

const WIDTH = Math.max(...[...TOP, ...BOTTOM].map((line) => line.length));

export function printBanner(out: NodeJS.WriteStream = process.stdout): void {
  if (!out.isTTY || (out.columns ?? 0) < WIDTH) return;
  const green = process.env.NO_COLOR ? (line: string) => line : (line: string) => `${GREEN}${line}${RESET}`;
  out.write(`\n${TOP.join('\n')}\n\n${BOTTOM.map(green).join('\n')}\n\n`);
}
