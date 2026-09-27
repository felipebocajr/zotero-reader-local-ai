#!/usr/bin/env python3
"""Development-only Firefox RDP client; requests are sent to a loopback Zotero debugger."""
import argparse
import json
import socket
import time


class Client:
    def __init__(self, port=18085):
        self.socket = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.socket.settimeout(30)
        self.buffer = b""
        self.greeting = self.receive()

    def receive(self):
        while b":" not in self.buffer:
            self.buffer += self.socket.recv(65536)
        length, tail = self.buffer.split(b":", 1)
        count = int(length)
        while len(tail) < count:
            chunk = self.socket.recv(65536)
            if not chunk: raise RuntimeError("Debugger disconnected")
            tail += chunk
        self.buffer = tail[count:]
        return json.loads(tail[:count])

    def request(self, to, kind, **kwargs):
        data = json.dumps({"to": to, "type": kind, **kwargs}).encode()
        self.socket.sendall(str(len(data)).encode() + b":" + data)
        while True:
            result = self.receive()
            if result.get("from") == to: return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18085)
    parser.add_argument("--code", help="JavaScript to evaluate in the isolated browser process")
    parser.add_argument("--file", help="Privileged script loaded only into the isolated Zotero profile")
    parser.add_argument("--verbose", action="store_true", help="Print debugger protocol metadata")
    args = parser.parse_args()
    client = Client(args.port)
    if args.verbose: print("greeting", json.dumps(client.greeting))
    root = client.request("root", "getRoot")
    if args.verbose: print("root", json.dumps(root)[:4000])
    target = client.request("root", "getProcess", id=0)
    if args.verbose: print("process", json.dumps(target)[:5000])
    if args.file:
        from pathlib import Path
        uri = Path(args.file).resolve().as_uri()
        args.code = 'Services.scriptloader.loadSubScriptWithOptions(' + json.dumps(uri) + ', {target:{Zotero, Services, IOUtils, ChromeUtils, Components}, ignoreCache:true})'
    if args.code:
        form = target.get("form", {})
        if target.get("processDescriptor"):
            descriptor = target["processDescriptor"]["actor"]
            target = client.request(descriptor, "getTarget")
            form = target.get("process", {})
        actor = form.get("consoleActor")
        if not actor and form.get("actor"):
            target_actor = form["actor"]
            attached = client.request(target_actor, "attach")
            if args.verbose: print("attach", json.dumps(attached)[:2000])
            actor = attached.get("consoleActor")
        if not actor: raise RuntimeError("Console actor not available")
        response = client.request(actor, "evaluateJSAsync", text=args.code)
        if args.verbose: print("evaluate", json.dumps(response))
        until = time.monotonic() + 30
        while time.monotonic() < until:
            event = client.receive()
            if event.get("type") == "evaluationResult":
                if args.verbose or event.get("hasException"): print("result", json.dumps(event)[:8000])
                elif isinstance(event.get("result"), str): print(event["result"])
                elif event.get("result", {}).get("type") == "undefined": print("Script executado; resultados assíncronos são gravados pelo harness.")
                else: print(json.dumps(event.get("result"))[:8000])
                break
    client.socket.close()


if __name__ == "__main__":
    main()
