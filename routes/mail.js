const express = require('express');
const { execSync } = require('child_process');
const router = express.Router();

/**
 * Search Apple Mail for emails related to the invoice
 * Uses AppleScript to interact with Apple Mail
 */
function searchMailAppleScript(searchTerm) {
  const script = `
tell application "Mail"
  set results to {}
  set allBoxes to every mailbox of every account
  repeat with boxList in allBoxes
    repeat with aBox in boxList
      try
        set theMessages to (messages of aBox whose subject contains "${searchTerm}" or sender contains "${searchTerm}")
        repeat with aMsg in theMessages
          set end of results to {subject:(subject of aMsg), sender:(sender of aMsg), dateSent:(date sent of aMsg) as string, msgId:(message id of aMsg)}
        end repeat
      end try
    end repeat
  end repeat
  return results
end tell`;
  try {
    const out = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 20000 }).toString();
    return out.trim();
  } catch (e) {
    throw new Error('AppleScript falló: ' + e.message);
  }
}

function printMailAppleScript(subject) {
  const script = `
tell application "Mail"
  set targetMsg to missing value
  repeat with aAccount in accounts
    repeat with aBox in mailboxes of aAccount
      try
        set msgs to (messages of aBox whose subject contains "${subject}")
        if (count of msgs) > 0 then
          set targetMsg to item 1 of msgs
          exit repeat
        end if
      end try
    end repeat
    if targetMsg is not missing value then exit repeat
  end repeat
  if targetMsg is not missing value then
    set theWindow to open for reading targetMsg
    tell application "System Events"
      keystroke "p" using command down
      delay 2
      key code 36
    end tell
  end if
end tell`;
  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 30000 });
    return true;
  } catch (e) {
    throw new Error('No se pudo imprimir: ' + e.message);
  }
}

// ── POST /api/mail/buscar ─────────────────────────────────
// Body: { searchTerm }  (RFC emisor, UUID, o nombre proveedor)
router.post('/buscar', (req, res) => {
  const { searchTerm } = req.body;
  if (!searchTerm) return res.status(400).json({ ok: false, error: 'Falta el término de búsqueda' });

  try {
    const raw = searchMailAppleScript(searchTerm);
    // Simple parse - AppleScript returns a comma-separated list of records
    const found = raw.length > 10; // If there's meaningful content
    return res.json({ ok: true, encontrado: found, raw, mensaje: found ? 'Correo encontrado en Apple Mail' : 'No se encontró ningún correo con ese término' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/mail/imprimir ───────────────────────────────
// Body: { subject }
router.post('/imprimir', (req, res) => {
  const { subject } = req.body;
  if (!subject) return res.status(400).json({ ok: false, error: 'Falta el asunto del correo' });

  try {
    printMailAppleScript(subject);
    return res.json({ ok: true, mensaje: 'Correo enviado a impresión desde Apple Mail' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
