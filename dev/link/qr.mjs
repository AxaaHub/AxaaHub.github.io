import { QrCode, QrSegment } from './vendor/qrcodegen.mjs';

export function encodeQRCode(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('请输入需要生成二维码的内容。');
  if (text.length > 4000) throw new Error('内容过长，请缩短内容后重试。');
  const bytes = new TextEncoder().encode(text);
  try {
    // ECI 26 explicitly identifies UTF-8. Preserve whitespace and Unicode as entered.
    return QrCode.encodeSegments([
      QrSegment.makeEci(26), QrSegment.makeBytes(Array.from(bytes))
    ], QrCode.Ecc.MEDIUM);
  } catch {
    throw new Error('内容超出二维码容量，请缩短内容后重试。');
  }
}

export function qrCodePNG(code) {
  const border = 4;
  const scale = Math.ceil(1024 / (code.size + border * 2));
  const size = (code.size + border * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法绘制二维码，请重试。');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#000000';
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.getModule(x, y)) context.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
    }
  }
  return { url: canvas.toDataURL('image/png'), size };
}

export function initQRCode() {
  const dialog = document.getElementById('qr-dialog');
  const input = document.getElementById('qr-content');
  const error = document.getElementById('qr-error');
  const output = document.getElementById('qr-output');
  const image = document.getElementById('qr-image');
  const download = document.getElementById('download-qr');
  let png = '';
  function clearOutput() {
    png = '';
    output.hidden = true;
    download.disabled = true;
    image.removeAttribute('src');
    document.getElementById('qr-summary').textContent = '';
  }
  function clearError() {
    error.hidden = true;
    error.textContent = '';
    input.setAttribute('aria-invalid', 'false');
  }
  document.getElementById('open-qr').addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
    input.focus();
  });
  document.getElementById('close-qr').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  input.addEventListener('input', () => { clearError(); clearOutput(); });
  document.getElementById('qr-form').addEventListener('submit', event => {
    event.preventDefault();
    clearError();
    clearOutput();
    try {
      const content = input.value;
      const result = qrCodePNG(encodeQRCode(content));
      png = result.url;
      image.src = png;
      document.getElementById('qr-summary').textContent =
        '已生成 · ' + Array.from(content).length + ' 个字符 · ' + result.size + ' × ' + result.size + ' px';
      download.disabled = false;
      output.hidden = false;
    } catch (problem) {
      error.textContent = problem.message || '二维码生成失败，请重试。';
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    }
  });
  download.addEventListener('click', () => {
    if (!png) return;
    const link = document.createElement('a');
    link.href = png;
    link.download = 'qrcode.png';
    link.click();
  });
}
