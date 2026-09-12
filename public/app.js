function createGenerationUi() {
  const messageInput = document.querySelector('#message');
  const generateButton = document.querySelector('#generateButton');
  const stopButton = document.querySelector('#stopButton');
  const statusLabel = document.querySelector('#status');
  const responseOutput = document.querySelector('#responseOutput');

  let isGenerating = false;
  let runningRequest = null;

function setStatus(status) {
  statusLabel.textContent = status;
}

function showMessage(message) {
  responseOutput.textContent = message;
}

function appendMessage(message) {
  responseOutput.textContent += message;
}

function parseSseEvent(rawEvent) {
  const event = {
    type: 'message',
    data: '',
  };

  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('event:')) {
      event.type = line.slice(6).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      event.data += `${line.slice(5).trimStart()}\n`;
    }
  }

  event.data = event.data.trimEnd();
  return event;
}

function setIdleControls() {
  generateButton.disabled = false;
  stopButton.disabled = true;
}

function setGeneratingControls() {
  generateButton.disabled = true;
  stopButton.disabled = false;
}

function isRunningRequest(generation) {
  return runningRequest === generation;
}

function finishGeneration(generation) {
  if (!isRunningRequest(generation)) {
    return;
  }

  isGenerating = false;
  runningRequest = null;
  setIdleControls();
}

function handleSseEvent(rawEvent, generation) {
  if (!isRunningRequest(generation)) {
    return;
  }

  const parsedEvent = parseSseEvent(rawEvent);

  if (!parsedEvent.data) {
    return;
  }

  const data = JSON.parse(parsedEvent.data);

  if (parsedEvent.type === 'status') {
    if (data.status === 'waiting') {
      setStatus('Esperando');
    }

    if (data.status === 'generating') {
      setStatus('Generando');
    }

    return;
  }

  if (parsedEvent.type === 'content') {
    appendMessage(data.delta);
    return;
  }

  if (parsedEvent.type === 'completed') {
    setStatus('Completado');
    generation.completed = true;
    finishGeneration(generation);
    return;
  }

  if (parsedEvent.type === 'error') {
    setStatus('Error');
    showMessage(data.message || 'No fue posible generar la respuesta. Intentalo nuevamente.');
    generation.failed = true;
    finishGeneration(generation);
  }
}

async function readSseStream(response, generation) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) {
      if (event.trim()) {
        handleSseEvent(event, generation);
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    handleSseEvent(buffer, generation);
  }
}

generateButton.addEventListener('click', async () => {
  if (isGenerating) {
    return;
  }

  const message = messageInput.value.trim();

  if (!message) {
    setStatus('Esperando');
    showMessage('Escribe un mensaje antes de continuar.');
    messageInput.focus();
    return;
  }

  const generation = {
    controller: new AbortController(),
    completed: false,
    failed: false,
    interrupted: false,
  };

  isGenerating = true;
  runningRequest = generation;
  setGeneratingControls();
  setStatus('Esperando');
  showMessage('');

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
      signal: generation.controller.signal,
    });

    if (!isRunningRequest(generation)) {
      return;
    }

    if (!response.ok || !response.body) {
      throw new Error('Generation request failed.');
    }

    await readSseStream(response, generation);
  } catch (error) {
    if (!isRunningRequest(generation)) {
      return;
    }

    if (error.name === 'AbortError') {
      generation.interrupted = true;
      setStatus('Interrumpido');
      finishGeneration(generation);
      return;
    }

    generation.failed = true;
    setStatus('Error');
    showMessage('No fue posible generar la respuesta. Intentalo nuevamente.');
    finishGeneration(generation);
  } finally {
    finishGeneration(generation);
  }
});

stopButton.addEventListener('click', () => {
  if (!runningRequest || runningRequest.controller.signal.aborted) {
    return;
  }

  runningRequest.interrupted = true;
  runningRequest.controller.abort();
  setStatus('Interrumpido');
  finishGeneration(runningRequest);
});

setIdleControls();
}

createGenerationUi();
