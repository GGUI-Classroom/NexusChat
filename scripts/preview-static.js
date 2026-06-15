const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '../public');
const port = Number(process.env.PREVIEW_PORT || 3005);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (urlPath === '/socket.io/socket.io.js') {
    return send(
      res,
      200,
      'window.io=function(){return {on(){},emit(){},connect(){},disconnect(){}}};',
      'application/javascript; charset=utf-8'
    );
  }

  const requested = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(root, requested);
  if (!file.startsWith(root)) return send(res, 403, 'Forbidden');

  fs.readFile(file, (err, body) => {
    if (err) {
      fs.readFile(path.join(root, 'index.html'), (fallbackErr, fallbackBody) => {
        if (fallbackErr) return send(res, 404, 'Not found');
        send(res, 200, fallbackBody, types['.html']);
      });
      return;
    }

    send(res, 200, body, types[path.extname(file)] || 'application/octet-stream');
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`Nexus UI preview running at http://127.0.0.1:${port}`);
});
