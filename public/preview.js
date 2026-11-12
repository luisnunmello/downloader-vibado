// Shows the file on the preview page. Text is fetched as a limited slice so huge files do not freeze the tab.
const TEXT_LIMIT = 256 * 1024;

const box = document.getElementById('preview');
const note = document.getElementById('note');
const { kind, src } = box.dataset;

if (kind === 'image') {
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  box.append(img);
} else if (kind === 'video') {
  const video = document.createElement('video');
  video.src = src;
  video.controls = true;
  box.append(video);
} else if (kind === 'text') {
  fetch(src, { headers: { range: `bytes=0-${TEXT_LIMIT - 1}` } })
    .then(async (res) => {
      if (!res.ok) throw new Error('Could not load the preview');
      const pre = document.createElement('pre');
      pre.textContent = await res.text();
      box.append(pre);
      if (res.status === 206) note.textContent = `Showing the first ${TEXT_LIMIT / 1024} KB. Download the file for the rest.`;
    })
    .catch((e) => (note.textContent = e.message));
}
