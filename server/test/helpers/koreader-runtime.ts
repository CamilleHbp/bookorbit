import { spawn } from 'node:child_process';

export function runKoreaderHttpFixture(port: number, config: object): Promise<string> {
  const command = `umask 077
task_validation=/srv/homeserver/data/bookorbit/app/validation/native-revisions
task_work=$(mktemp -d "$task_validation/http-delivery-XXXXXX") || exit 1
trap 'rm -f "$task_work/config.json"' EXIT
cat > "$task_work/config.json"
cd "$task_validation/koreader-runtime/lib/koreader" || exit
KO_HOME="$task_work" SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 180s ./luajit "$task_validation/spec/bookorbit_delivery_http_runtime_test.lua" "$task_validation" "$task_validation/bookorbit.koplugin" "$task_work"
exit $?`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      [
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=10',
        '-o',
        'ServerAliveCountMax=2',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ControlMaster=no',
        '-o',
        'ControlPath=none',
        '-R',
        `127.0.0.1:18441:127.0.0.1:${port}`,
        'nf-showcases',
        command,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 210_000);
    const collect = (chunk: Buffer) => {
      if (output.length + chunk.length > 4 * 1024 * 1024) child.kill('SIGTERM');
      else output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`KOReader HTTP fixture failed (${code}): ${output}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(config));
  });
}
