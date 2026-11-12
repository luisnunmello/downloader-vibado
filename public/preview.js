// Shows the file on the download page. Anything heavy waits for the visitor: a video starts loading
// only when they press play, a big image only when they ask for it. Text is a small slice, shown at once.
const TEXT_LIMIT = 256 * 1024;
const BIG_IMAGE_BYTES = 5 * 1024 * 1024;

const box = document.getElementById('preview');
const note = document.getElementById('note');
const { kind, src, bytes, poster } = box.dataset;
const megabytes = (Number(bytes) / 1024 / 1024).toFixed(1);

function showImage() {
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  box.replaceChildren(img);
}

if (kind === 'image') {
  if (Number(bytes) > BIG_IMAGE_BYTES) {
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'secondary';
    load.textContent = `Load image (${megabytes} MB)`;
    load.addEventListener('click', showImage);
    box.append(load);
  } else {
    showImage();
  }
} else if (kind === 'video') {
  const video = document.createElement('video');
  video.controls = true;
  video.preload = 'none'; // nothing is downloaded until the visitor presses play
  if (poster) video.poster = poster;
  video.src = src;
  box.append(video);
  note.textContent = `Video, ${megabytes} MB. It only starts loading when you press play.`;
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
