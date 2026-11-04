#!/usr/bin/env python3
"""Loopback-only browser helper for generating catalogue icons from local Minecraft assets."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import subprocess
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output'; OUT.mkdir(exist_ok=True)
subprocess.run(['node','--input-type=module','-e',
    "import {build} from 'esbuild';await build({entryPoints:['build-block-icons.js'],bundle:true,format:'esm',outfile:'../output/icons.bundle.js'});"],
    cwd=ROOT/'frontend',check=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.path=urlsplit(self.path).path
        paths={'/build-icons.js':(OUT/'icons.bundle.js','text/javascript'),
               '/mc-assets/models.json':(ROOT/'static/minecraft/models.json.gz','application/json'),
               '/mc-assets/atlas.png':(ROOT/'static/minecraft/atlas.png','image/png')}
        if self.path=='/':
            body=b'<!doctype html><meta charset="utf-8"><title>Local icon generator</title><h1>Local block icons</h1><p>This loopback helper generates icons from your installed Minecraft assets.</p><button id="build">Build icons</button><p id="status">Ready</p><script type="module" src="/build-icons.js"></script>'
            mime='text/html'
        elif self.path in paths:
            path,mime=paths[self.path]
            if not path.is_file():return self.send_error(404,'Prepare local assets first')
            body=path.read_bytes()
        else:return self.send_error(404)
        self.send_response(200);self.send_header('Content-Type',mime)
        if self.path.endswith('models.json'):self.send_header('Content-Encoding','gzip')
        self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

    def do_POST(self):
        if self.headers.get('Origin') not in (None,'http://127.0.0.1:8875'):
            return self.send_error(403)
        if self.path not in ('/save-icons','/save-index'):return self.send_error(404)
        size=int(self.headers.get('Content-Length','0'))
        if not 0<size<=10*1024*1024:return self.send_error(413)
        body=self.rfile.read(size)
        if self.path=='/save-icons':
            if not body.startswith(b'\x89PNG\r\n\x1a\n'):return self.send_error(400)
            name='block-icons.png'
        else:
            try:
                data=json.loads(body)
                if not isinstance(data.get('blocks'),dict):raise ValueError()
            except (ValueError,AttributeError):return self.send_error(400)
            name='block-icons.json'
        target=ROOT/'static/minecraft'/name;target.parent.mkdir(exist_ok=True)
        target.write_bytes(body);self.send_response(204);self.end_headers()


if __name__=='__main__':
    print('Open http://127.0.0.1:8875 and press Build icons.',flush=True)
    HTTPServer(('127.0.0.1',8875),Handler).serve_forever()
