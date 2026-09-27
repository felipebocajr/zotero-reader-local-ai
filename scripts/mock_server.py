#!/usr/bin/env python3
"""Loopback fixture for native Zotero UI tests; never a production model server."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import time

REQUESTS = []
STATE = {"tokens": 10000}
ANSWER = "A atenção calcula a relevância de cada chave para uma consulta e usa os pesos resultantes para combinar os valores. No artigo, a divisão pela raiz quadrada da dimensão das chaves mantém os produtos escalares numa escala adequada, evitando que o softmax fique saturado. Esta resposta simulada verifica apenas a interface; a qualidade do modelo é avaliada separadamente."
MATH_ANSWER = r"""A distribuição condicional se decompõe no produto das distribuições por posição:
\[q_{t\mid 0}(x_t\mid x_0)=\prod_{i=1}^{n}q_{t\mid 0}(\xi_t^{(i)}\mid\xi_0^{(i)})\]
Os termos \(x_t\) e $x_0$ mantêm seus índices. Frações e raízes também são preservadas: $$\frac{QK^{\mathsf T}}{\sqrt{d_k}}$$.
"""
MARKDOWN_ANSWER = r"""## Explicação contextual

O artigo usa **atenção** para conectar posições; *cada token* recebe contexto.

- Relação com o método
- Resultado descrito

A escala é \(\frac{QK^{\mathsf T}}{\sqrt{d_k}}\). `**literal**` permanece como código.

<img src="https://example.com/remote.png" onerror="alert(1)">
![Figura](https://example.com/remote.png)
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def json(self, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        routes = {"/health": {"status": "ok"}, "/props": {"total_slots": 1, "default_generation_settings": {"n_ctx": 32768}},
                  "/v1/models": {"data": [{"id": "lfm2.5-2.6b"}]}, "/requests": REQUESTS}
        if self.path in routes: self.json(routes[self.path])
        else: self.send_error(404)

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/control": STATE.update(data); self.json(STATE); return
        if self.path == "/apply-template": self.json({"prompt": json.dumps(data["messages"])}); return
        if self.path == "/tokenize": self.json({"tokens": [1] * STATE["tokens"]}); return
        if self.path != "/v1/chat/completions": self.send_error(404); return
        messages = data["messages"]
        REQUESTS.append({"messages": messages, "max_tokens": data["max_tokens"]})
        question = messages[-1]["content"]
        answer = MARKDOWN_ANSWER if "UI_MARKDOWN" in question else MATH_ANSWER if "UI_MATH" in question or STATE.get("math") else ANSWER
        if "UI_MATH_INVALID" in question: answer += r" Expressão incompleta: \[\frac{a}{\]. <img src='https://example.com/a.png'>"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        def emit(value):
            self.wfile.write(("data: " + (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)) + "\n\n").encode())
            self.wfile.flush()
        try:
            emit({"choices": [{"delta": {"reasoning_content": "SECRET_REASONING_NOT_FOR_UI"}}]})
            if "UI_SLOW" in question: time.sleep(8)
            if "UI_INTERRUPTED" in question: return
            for start in range(0, len(answer), 32):
                emit({"choices": [{"delta": {"content": answer[start:start + 32]}}]})
                time.sleep(.03)
            emit({"choices": [{"delta": {}, "finish_reason": "length" if "UI_LENGTH" in question else "stop"}], "usage": {"completion_tokens": 90}})
            emit("[DONE]")
        except (BrokenPipeError, ConnectionResetError): pass


if __name__ == "__main__":
    print("UI fixture: http://127.0.0.1:18080", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 18080), Handler).serve_forever()
