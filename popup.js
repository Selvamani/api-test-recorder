document.getElementById("btn").addEventListener("click", openRecorder);

function openRecorder() {
  const btn = document.getElementById("btn");
  const status = document.getElementById("status");
  btn.disabled = true;
  status.textContent = "Opening recorder…";
  chrome.runtime.sendMessage({ type: "OPEN_RECORDER" }, (res) => {
    if (res && res.ok) {
      status.textContent = "Recorder opened!";
      setTimeout(() => window.close(), 600);
    } else {
      status.textContent = "Error: " + (res?.error || "unknown");
      btn.disabled = false;
    }
  });
}
