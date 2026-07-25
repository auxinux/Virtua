<?php
declare(strict_types=1);

$baseUrl = 'https://dep.auxinux.ca/scripts';
$dir = __DIR__;

function h(string $value): string {
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function readMeta(string $path): array {
    $meta = ['name' => basename($path), 'desc' => ''];
    $handle = fopen($path, 'rb');
    if (!$handle) {
        return $meta;
    }

    for ($i = 0; $i < 20 && ($line = fgets($handle)) !== false; $i++) {
        $line = trim($line);
        if (str_starts_with($line, '#NAME=')) {
            $meta['name'] = trim(substr($line, 6));
        }
        if (str_starts_with($line, '#DESC=')) {
            $meta['desc'] = trim(substr($line, 6));
        }
    }
    fclose($handle);

    return $meta;
}

function scriptList(string $dir): array {
    $items = [];
    foreach (glob($dir . '/*.sh') ?: [] as $path) {
        $file = basename($path);
        if (!preg_match('/^[A-Za-z0-9._-]+\.sh$/', $file)) {
            continue;
        }
        $meta = readMeta($path);
        $items[$file] = [
            'file' => $file,
            'name' => $meta['name'] ?: $file,
            'desc' => $meta['desc'] ?: '',
            'path' => $path,
        ];
    }
    ksort($items, SORT_NATURAL | SORT_FLAG_CASE);
    return $items;
}

$scripts = scriptList($dir);
$highlight = isset($_GET['highlight']) ? basename((string) $_GET['highlight']) : '';
$view = isset($_GET['view']) ? basename((string) $_GET['view']) : '';
$viewItem = ($view !== '' && isset($scripts[$view])) ? $scripts[$view] : null;
$viewContent = $viewItem ? file_get_contents($viewItem['path']) : '';
?><!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AuxiNux Scripts</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #111a2e;
      --panel-2: #0f1728;
      --text: #e5edf8;
      --muted: #99a8bd;
      --line: #26354f;
      --accent: #5db7ff;
      --accent-2: #92d36e;
      --danger: #ff7a7a;
      --shadow: 0 18px 45px rgba(0, 0, 0, .28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top left, rgba(93, 183, 255, .12), transparent 30%), var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    main {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 34px 0 48px;
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 24px;
    }
    h1 { margin: 0 0 6px; font-size: clamp(28px, 4vw, 42px); line-height: 1.1; }
    h2 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0; color: var(--muted); }
    .toggle {
      display: inline-flex;
      border: 1px solid var(--line);
      background: var(--panel-2);
      border-radius: 8px;
      padding: 4px;
      flex-shrink: 0;
    }
    .toggle button {
      border: 0;
      color: var(--muted);
      background: transparent;
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 700;
    }
    .toggle button.active { background: var(--accent); color: #07111f; }
    .grid { display: grid; gap: 14px; }
    .card {
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 18px;
    }
    .script-card.highlight {
      border-color: var(--accent-2);
      box-shadow: 0 0 0 2px rgba(146, 211, 110, .25), var(--shadow);
    }
    .meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .filename {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--accent);
      word-break: break-all;
      font-size: 13px;
    }
    .command {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: stretch;
      margin-top: 14px;
    }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    code {
      display: block;
      overflow-x: auto;
      border: 1px solid var(--line);
      background: #07101e;
      border-radius: 8px;
      padding: 10px 12px;
      color: #d9f2ff;
      white-space: nowrap;
    }
    pre {
      overflow: auto;
      max-height: 72vh;
      border: 1px solid var(--line);
      background: #050b14;
      border-radius: 8px;
      padding: 16px;
      color: #dbeafe;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 38px;
      padding: 9px 12px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: #17243a;
      color: var(--text);
      text-decoration: none;
      cursor: pointer;
      font-weight: 700;
      font-size: 14px;
    }
    .btn.primary { background: var(--accent); color: #07111f; border-color: var(--accent); }
    .btn:hover { filter: brightness(1.08); }
    .empty { color: var(--danger); }
    [data-lang="en"] { display: none; }
    body.lang-en [data-lang="fr"] { display: none; }
    body.lang-en [data-lang="en"] { display: revert; }
    @media (max-width: 720px) {
      header { flex-direction: column; }
      .meta { flex-direction: column; align-items: flex-start; }
      .command { grid-template-columns: 1fr; }
      .btn { width: 100%; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>AuxiNux Scripts</h1>
      <p data-lang="fr">Scripts publics pour configurer rapidement les sources AuxiNux.</p>
      <p data-lang="en">Public scripts to quickly configure AuxiNux sources.</p>
    </div>
    <div class="toggle" aria-label="Language">
      <button type="button" id="langFr" class="active">FR</button>
      <button type="button" id="langEn">EN</button>
    </div>
  </header>

<?php if ($viewItem): ?>
  <section class="card">
    <div class="meta">
      <div>
        <h2><?= h($viewItem['name']) ?></h2>
        <div class="filename"><?= h($viewItem['file']) ?></div>
      </div>
      <a class="btn" href="./<?= h($highlight ? '?highlight=' . rawurlencode($highlight) : '') ?>">
        <span data-lang="fr">Retour à la liste</span>
        <span data-lang="en">Back to list</span>
      </a>
    </div>
    <pre><?= h((string) $viewContent) ?></pre>
  </section>
<?php else: ?>
  <?php if (!$scripts): ?>
    <section class="card empty">
      <span data-lang="fr">Aucun script disponible pour le moment.</span>
      <span data-lang="en">No script is available yet.</span>
    </section>
  <?php else: ?>
    <section class="grid">
    <?php foreach ($scripts as $item):
        $file = $item['file'];
        $isHighlight = ($highlight !== '' && hash_equals($file, $highlight));
        $scriptUrl = $baseUrl . '/' . rawurlencode($file);
        $shareUrl = $baseUrl . '/?highlight=' . rawurlencode($file);
        $command = 'curl -fsSL ' . $scriptUrl . ' | sudo bash';
    ?>
      <article id="<?= h($file) ?>" class="card script-card<?= $isHighlight ? ' highlight' : '' ?>">
        <div class="meta">
          <div>
            <h2><?= h($item['name']) ?></h2>
            <div class="filename"><?= h($file) ?></div>
          </div>
          <?php if ($isHighlight): ?>
            <strong style="color: var(--accent-2);">
              <span data-lang="fr">Script partagé</span>
              <span data-lang="en">Shared script</span>
            </strong>
          <?php endif; ?>
        </div>
        <p><?= h($item['desc']) ?></p>
        <div class="command">
          <code id="cmd-<?= h($file) ?>"><?= h($command) ?></code>
          <button class="btn primary" type="button" data-copy="<?= h($command) ?>">
            <span data-lang="fr">Copier</span>
            <span data-lang="en">Copy</span>
          </button>
        </div>
        <div class="actions">
          <button class="btn" type="button" data-copy="<?= h($shareUrl) ?>">
            <span data-lang="fr">Partager</span>
            <span data-lang="en">Share</span>
          </button>
          <a class="btn" href="?view=<?= rawurlencode($file) ?><?= $highlight ? '&highlight=' . rawurlencode($highlight) : '' ?>">
            <span data-lang="fr">Voir le contenu</span>
            <span data-lang="en">View content</span>
          </a>
          <a class="btn" href="<?= h($file) ?>" download>
            <span data-lang="fr">Télécharger</span>
            <span data-lang="en">Download</span>
          </a>
        </div>
      </article>
    <?php endforeach; ?>
    </section>
  <?php endif; ?>
<?php endif; ?>
</main>

<script>
  const langFr = document.getElementById('langFr');
  const langEn = document.getElementById('langEn');
  function setLang(lang) {
    document.body.classList.toggle('lang-en', lang === 'en');
    langFr.classList.toggle('active', lang === 'fr');
    langEn.classList.toggle('active', lang === 'en');
    document.documentElement.lang = lang;
    localStorage.setItem('auxinux-scripts-lang', lang);
  }
  langFr.addEventListener('click', () => setLang('fr'));
  langEn.addEventListener('click', () => setLang('en'));
  setLang(localStorage.getItem('auxinux-scripts-lang') || 'fr');

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.getAttribute('data-copy') || '';
      const previous = button.innerHTML;
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = document.body.classList.contains('lang-en') ? 'Copied' : 'Copié';
      } catch {
        window.prompt(document.body.classList.contains('lang-en') ? 'Copy this value:' : 'Copiez cette valeur :', value);
      }
      window.setTimeout(() => { button.innerHTML = previous; }, 1200);
    });
  });

  const highlighted = document.querySelector('.script-card.highlight');
  if (highlighted) {
    highlighted.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
</script>
</body>
</html>
