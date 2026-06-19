const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const localDir = path.join(root, 'LOCAL FILES');

const indexPath = path.join(localDir, 'index.html');
const cssPath = path.join(localDir, 'css', 'main.css');
const configPath = path.join(localDir, 'js', 'local-config.js');
const appPath = path.join(localDir, 'js', 'app.js');
const outputPath = path.join(localDir, 'NexusChat-OneFile.html');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function escapeStyle(css) {
  return css.replace(/<\/style/gi, '<\\/style');
}

function escapeScript(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

let html = read(indexPath);
const css = escapeStyle(read(cssPath));
const config = escapeScript(read(configPath));
const app = escapeScript(read(appPath));

html = html.replace(
  '  <link rel="stylesheet" href="css/main.css" />',
  `  <style>\n${css}\n  </style>`
);

html = html.replace(
  '  <script src="js/local-config.js"></script>\r\n  <script src="js/app.js"></script>',
  `  <script>\n${config}\n  </script>\r\n  <script>\n${app}\n  </script>`
);

html = html.replace(
  '  <script src="js/local-config.js"></script>\n  <script src="js/app.js"></script>',
  `  <script>\n${config}\n  </script>\n  <script>\n${app}\n  </script>`
);

fs.writeFileSync(outputPath, html);
console.log(`Built ${path.relative(root, outputPath)}`);
