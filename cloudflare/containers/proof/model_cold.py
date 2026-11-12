"""Measure synthetic local CPU requests on fresh containers, never hosted providers."""
import json
import subprocess
import sys
import time


def run(*args):
    return subprocess.check_output(args, text=True).strip()


CACHE = ['/root/.u2net', '/root/.cache/huggingface', '/root/.cache/torch', '/root/.realesrgan']


def cache(name):
    values = {}
    for path in CACHE:
        result = run('docker', 'exec', name, 'sh', '-c',
                     f'if test -d {path}; then du -sk {path}; else printf "0"; fi')
        values[path] = int(result.split()[0]) * 1024
    return values


FIXTURES = '''from PIL import Image, ImageDraw
import subprocess
im = Image.new('RGB', (1024,1024), 'white')
ImageDraw.Draw(im).ellipse((250,250,750,750), fill='red')
im.save('/tmp/photo.png')
im.resize((64,64)).save('/tmp/small.png')
mask = Image.new('L',(64,64),0)
ImageDraw.Draw(mask).rectangle((24,24,32,32),fill=255)
mask.save('/tmp/mask.png')
subprocess.run(['ffmpeg','-y','-loglevel','error','-f','lavfi','-i',
 'color=size=160x120:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2',
 '-c:v','libx264','-c:a','aac','-shortest','/tmp/video.mp4'],check=True)
'''


def main(image, output):
    assert run('docker', 'image', 'inspect', image, '--format', '{{.Architecture}}') == 'arm64'
    assert 'OrbStack' in run('docker', 'info', '--format', '{{.OperatingSystem}}')
    report = {'host': 'arm64 OrbStack, not Cloudflare', 'image': image,
              'cache_metric': 'du -sk allocated KiB multiplied by 1024', 'operations': {}}
    operations = {
        'remove-bg': ('/api/remove-background', ['file=@/tmp/photo.png']),
        'transcribe': ('/api/transcribe-video', ['file=@/tmp/video.mp4', 'engine=cpu', 'language=en']),
        'lama-inpaint': ('/api/inpaint-image', ['image=@/tmp/small.png', 'mask=@/tmp/mask.png']),
        'upscale': ('/api/upscale-image', ['file=@/tmp/small.png', 'scale=2']),
    }
    assert len(operations) == 4
    for op, (endpoint, fields) in operations.items():
        name = 'p1w' if op == 'remove-bg' else 'p1w-' + op
        args = ['docker', 'run', '-d', '--name', name, '--cpus', '4', '--memory', '12g']
        if op == 'remove-bg':
            args += ['--network', 'none', '-p', '8000:8000']
        args += ['-e', 'MEDIA_INPAINT_PROVIDER=local', '-e', 'MEDIA_UPSCALE_PROVIDER=local',
                 '-e', 'MEDIA_BG_PROVIDER=local', image,
                 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '8000']
        run(*args)
        try:
            for attempt in range(90):
                ready = subprocess.run(['docker', 'exec', name, 'curl', '-fsS',
                                        'http://localhost:8000/health'], capture_output=True)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError(f'{name}: health did not become ready')
            run('docker', 'exec', name, 'python', '-c', FIXTURES)
            before = cache(name)
            calls = []
            for _ in range(2):
                cmd = ['docker', 'exec', name, 'curl', '-sS', '--max-time', '600',
                       '-o', '/tmp/response', '-w', '%{http_code} %{time_total}',
                       'http://localhost:8000' + endpoint]
                for field in fields:
                    cmd += ['-F', field]
                result = subprocess.run(cmd, capture_output=True, text=True)
                parts = result.stdout.split()
                call = {'status': int(parts[0]) if parts else None,
                        'seconds': float(parts[1]) if len(parts) == 2 else None,
                        'curl_exit': result.returncode}
                if call['status'] != 200:
                    call['error'] = run('docker', 'exec', name, 'python', '-c',
                                        "print(open('/tmp/response').read()[:1500])")
                calls.append(call)
            after = cache(name)
            report['operations'][op] = {'endpoint': endpoint, 'calls': calls,
                'network': 'none' if op == 'remove-bg' else 'default',
                'cache_before_bytes': before, 'cache_after_bytes': after,
                'cache_added_bytes': {p: after[p] - before[p] for p in CACHE}}
            print(op, json.dumps(report['operations'][op]), flush=True)
            with open(output, 'w') as handle:
                json.dump(report, handle, indent=2)
                handle.write('\n')
        finally:
            run('docker', 'rm', '-f', name)
    assert set(report['operations']) == set(operations)
    offline = report['operations']['remove-bg']['calls'][0]
    assert offline['status'] == 200 and offline['seconds'] < 10, offline


if __name__ == '__main__':
    main(*sys.argv[1:])
