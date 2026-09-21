import hmac
import json
import os
import subprocess
import threading
from glob import glob
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from memorylane_photos.catalog import load_catalog, map_photo, validate_library

HOST = "127.0.0.1"
PORT = int(os.environ["MEMORYLANE_PLUGIN_PORT"])
TOKEN = os.environ["MEMORYLANE_PLUGIN_TOKEN"]

class Handler(BaseHTTPRequestHandler):
    catalog_cache = {}
    def log_message(self, *_): pass
    def send_json(self, status, payload):
        body=json.dumps(payload).encode(); self.send_response(status); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
    def authorized(self):
        if not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}"):
            self.send_json(401,{"error":"Unauthorized"}); return False
        return True
    def body(self):
        length=int(self.headers.get("Content-Length","0"));
        if length < 0 or length > 16384: raise ValueError("Invalid request size")
        return json.loads(self.rfile.read(length) or b"{}")
    def do_GET(self):
        if not self.authorized(): return
        if self.path == "/health": return self.send_json(200,{"status":"ready","pluginId":os.environ["MEMORYLANE_PLUGIN_ID"],"version":os.environ["MEMORYLANE_PLUGIN_VERSION"],"pluginApi":int(os.environ["MEMORYLANE_PLUGIN_API"])})
        if self.path == "/libraries":
            items=[]
            for raw in glob(str(Path.home()/"Pictures"/"*.photoslibrary")):
                try: validate_library(raw); items.append({"path":raw,"readable":True})
                except Exception as error: items.append({"path":raw,"readable":False,"reason":str(error)})
            return self.send_json(200,items)
        self.send_json(404,{"error":"Not found"})
    def do_POST(self):
        if not self.authorized(): return
        try:
            body=self.body()
            if self.path == "/catalog":
                library=validate_library(body["library_path"]); cursor=int(body.get("cursor",0)); limit=int(body.get("limit",200)); key=str(library)
                if cursor == 0 or key not in self.catalog_cache: self.catalog_cache[key]=load_catalog(library)
                assets=self.catalog_cache[key]; page=assets[cursor:cursor+limit]; mapped=[]; failures=[]
                for item in page:
                    try: mapped.append(item if isinstance(item,dict) else map_photo(item))
                    except Exception as error: failures.append({"uuid":str(getattr(item,"uuid","unknown")),"error":str(error)})
                next_cursor=cursor+limit if cursor+limit<len(assets) else None
                if next_cursor is None: self.catalog_cache.pop(key,None)
                return self.send_json(200,{"assets":mapped,"failures":failures,"next_cursor":next_cursor,"total":len(assets)})
            if self.path == "/open":
                uuid=str(body["uuid"]); script='on run argv\nset targetId to item 1 of argv\ntell application "Photos"\nactivate\nspotlight media item id targetId\nend tell\nend run'
                subprocess.run(["osascript","-e",script,uuid],check=True,capture_output=True,text=True,timeout=15); return self.send_json(200,{"ok":True})
            if self.path == "/shutdown":
                threading.Timer(0.1,lambda:os._exit(0)).start(); return self.send_json(200,{"ok":True})
            self.send_json(404,{"error":"Not found"})
        except Exception as error: self.send_json(503,{"error":str(error)})

if __name__ == "__main__":
    import osxphotos
    ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
