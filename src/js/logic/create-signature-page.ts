import { createIcons, icons } from 'lucide';
import {
  saveSignature,
  getSignatures,
  type SavedSignature,
} from '../utils/signature-storage.js';

// Import signature fonts
import '@fontsource/dancing-script';
import '@fontsource/great-vibes';
import '@fontsource/cedarville-cursive';
import '@fontsource/kalam';

interface SignatureStyle {
  id: string;
  name: string;
  fontFamily: string;
  description: string;
}

const SIGNATURE_STYLES: SignatureStyle[] = [
  {
    id: 'dancing',
    name: 'Elegant',
    fontFamily: 'Dancing Script',
    description: 'Flowing cursive style',
  },
  {
    id: 'vibes',
    name: 'Stylish',
    fontFamily: 'Great Vibes',
    description: 'Decorative calligraphy',
  },
  {
    id: 'cedarville',
    name: 'Natural',
    fontFamily: 'Cedarville Cursive',
    description: 'Authentic handwriting',
  },
  {
    id: 'kalam',
    name: 'Casual',
    fontFamily: 'Kalam',
    description: 'Relaxed handwriting',
  },
];

interface SignatureState {
  name: string;
  selectedStyle: string;
  color: string;
  size: number;
}

const state: SignatureState = {
  name: '',
  selectedStyle: 'dancing',
  color: '#1a365d',
  size: 1.0,
};

// Canvas dimensions for high-quality export
const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 200;
const DEVICE_PIXEL_RATIO = 2; // For retina displays

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage);
} else {
  initializePage();
}

async function initializePage() {
  createIcons({ icons });

  // Wait for fonts to load
  await document.fonts.ready;

  // Initialize UI
  setupStyleCards();
  setupEventListeners();
  updateButtonStates();
}

function setupStyleCards() {
  const container = document.getElementById('signature-styles');
  if (!container) return;

  container.innerHTML = '';

  SIGNATURE_STYLES.forEach((style) => {
    const card = document.createElement('div');
    card.className = `signature-style-card cursor-pointer rounded-lg border-2 p-4 transition-all duration-200 ${
      state.selectedStyle === style.id
        ? 'border-orange-500 bg-gray-700'
        : 'border-gray-600 bg-gray-900 hover:border-gray-500'
    }`;
    card.dataset.styleId = style.id;

    const canvas = document.createElement('canvas');
    canvas.className = 'w-full h-20 mb-2';
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    canvas.style.width = '100%';
    canvas.style.height = '80px';
    canvas.dataset.styleId = style.id;

    const labelContainer = document.createElement('div');
    labelContainer.className = 'flex items-center justify-between';

    const textContainer = document.createElement('div');

    const styleName = document.createElement('div');
    styleName.className = 'text-sm font-medium text-white';
    styleName.textContent = style.name;

    const styleDesc = document.createElement('div');
    styleDesc.className = 'text-xs text-gray-400';
    styleDesc.textContent = style.description;

    textContainer.appendChild(styleName);
    textContainer.appendChild(styleDesc);

    const checkbox = document.createElement('div');
    checkbox.className = `w-5 h-5 rounded-full border-2 flex items-center justify-center ${
      state.selectedStyle === style.id
        ? 'border-orange-500 bg-orange-500'
        : 'border-gray-500'
    }`;
    if (state.selectedStyle === style.id) {
      checkbox.innerHTML =
        '<svg class="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>';
    }

    labelContainer.appendChild(textContainer);
    labelContainer.appendChild(checkbox);

    card.appendChild(canvas);
    card.appendChild(labelContainer);
    container.appendChild(card);

    // Render initial preview
    renderSignatureOnCanvas(canvas, style.fontFamily);

    // Add click handler
    card.addEventListener('click', () => {
      state.selectedStyle = style.id;
      setupStyleCards(); // Re-render to update selection
    });
  });
}

function renderSignatureOnCanvas(
  canvas: HTMLCanvasElement,
  fontFamily: string
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Set canvas resolution for sharp rendering
  canvas.width = CANVAS_WIDTH * DEVICE_PIXEL_RATIO;
  canvas.height = CANVAS_HEIGHT * DEVICE_PIXEL_RATIO;
  ctx.scale(DEVICE_PIXEL_RATIO, DEVICE_PIXEL_RATIO);

  // Clear canvas
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const displayName = state.name || 'Your Name';
  const fontSize = Math.min(48 * state.size, 72);

  // Set font
  ctx.font = `${fontSize}px "${fontFamily}", cursive`;
  ctx.fillStyle = state.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  // Draw text centered
  ctx.fillText(displayName, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
}

function renderAllPreviews() {
  const canvases = document.querySelectorAll(
    '#signature-styles canvas'
  ) as NodeListOf<HTMLCanvasElement>;
  canvases.forEach((canvas) => {
    const styleId = canvas.dataset.styleId;
    const style = SIGNATURE_STYLES.find((s) => s.id === styleId);
    if (style) {
      renderSignatureOnCanvas(canvas, style.fontFamily);
    }
  });
}

function setupEventListeners() {
  // Name input
  const nameInput = document.getElementById(
    'signature-name'
  ) as HTMLInputElement;
  if (nameInput) {
    nameInput.addEventListener('input', (e) => {
      state.name = (e.target as HTMLInputElement).value;
      renderAllPreviews();
      updateButtonStates();
    });
  }

  // Color buttons
  const colorButtons = document.querySelectorAll('.color-btn');
  colorButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const color = (btn as HTMLElement).dataset.color;
      if (color) {
        state.color = color;
        updateColorButtonSelection();
        renderAllPreviews();
      }
    });
  });

  // Initial color selection
  updateColorButtonSelection();

  // Size slider
  const sizeSlider = document.getElementById(
    'signature-size'
  ) as HTMLInputElement;
  const sizeValue = document.getElementById('size-value');
  if (sizeSlider) {
    sizeSlider.addEventListener('input', (e) => {
      state.size = parseFloat((e.target as HTMLInputElement).value);
      if (sizeValue) {
        sizeValue.textContent = `${state.size.toFixed(1)}x`;
      }
      renderAllPreviews();
    });
  }

  // Download button
  const downloadBtn = document.getElementById('download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', downloadSignature);
  }

  // Save to Library button
  const saveToLibraryBtn = document.getElementById('save-to-library-btn');
  if (saveToLibraryBtn) {
    saveToLibraryBtn.addEventListener('click', saveToLibrary);
  }

  // Use in Sign PDF button (saves to library and navigates)
  const useInSignBtn = document.getElementById('use-in-sign-pdf-btn');
  if (useInSignBtn) {
    useInSignBtn.addEventListener('click', useInSignPdf);
  }

  // Back to tools
  document.getElementById('back-to-tools')?.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });
}

function updateColorButtonSelection() {
  const colorButtons = document.querySelectorAll('.color-btn');
  colorButtons.forEach((btn) => {
    const color = (btn as HTMLElement).dataset.color;
    if (color === state.color) {
      btn.classList.remove('border-gray-600');
      btn.classList.add('border-orange-500', 'ring-2', 'ring-orange-500');
    } else {
      btn.classList.add('border-gray-600');
      btn.classList.remove('border-orange-500', 'ring-2', 'ring-orange-500');
    }
  });
}

function updateButtonStates() {
  const hasName = state.name.trim().length > 0;
  const downloadBtn = document.getElementById(
    'download-btn'
  ) as HTMLButtonElement;
  const saveToLibraryBtn = document.getElementById(
    'save-to-library-btn'
  ) as HTMLButtonElement;
  const useInSignBtn = document.getElementById(
    'use-in-sign-pdf-btn'
  ) as HTMLButtonElement;

  if (downloadBtn) {
    downloadBtn.disabled = !hasName;
  }
  if (saveToLibraryBtn) {
    saveToLibraryBtn.disabled = !hasName;
  }
  if (useInSignBtn) {
    useInSignBtn.disabled = !hasName;
  }
}

function generateSignatureBlob(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const style = SIGNATURE_STYLES.find((s) => s.id === state.selectedStyle);
    if (!style) {
      reject(new Error('Style not found'));
      return;
    }

    // Create a new canvas for export
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = CANVAS_WIDTH * DEVICE_PIXEL_RATIO;
    exportCanvas.height = CANVAS_HEIGHT * DEVICE_PIXEL_RATIO;

    const ctx = exportCanvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Could not get canvas context'));
      return;
    }

    ctx.scale(DEVICE_PIXEL_RATIO, DEVICE_PIXEL_RATIO);

    // Transparent background (don't fill)

    const fontSize = Math.min(48 * state.size, 72);
    ctx.font = `${fontSize}px "${style.fontFamily}", cursive`;
    ctx.fillStyle = state.color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    ctx.fillText(state.name, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);

    exportCanvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to generate blob'));
        }
      },
      'image/png',
      1.0
    );
  });
}

async function downloadSignature() {
  try {
    const blob = await generateSignatureBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `signature-${state.name.replace(/\s+/g, '-').toLowerCase()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Failed to download signature:', error);
    alert('Failed to generate signature. Please try again.');
  }
}

async function saveToLibrary() {
  try {
    const blob = await generateSignatureBlob();

    const signatures = getSignatures();
    const signature: SavedSignature = {
      id: crypto.randomUUID(),
      name: state.name,
      style: state.selectedStyle,
      color: state.color,
      createdAt: Date.now(),
      isDefault: signatures.length === 0, // First signature is default
    };

    await saveSignature(signature, blob);

    alert('Signature saved to your library!');
  } catch (error) {
    console.error('Failed to save signature to library:', error);
    alert('Failed to save signature. Please try again.');
  }
}

async function useInSignPdf() {
  try {
    const blob = await generateSignatureBlob();

    // Save to library first
    const signatures = getSignatures();
    const signature: SavedSignature = {
      id: crypto.randomUUID(),
      name: state.name,
      style: state.selectedStyle,
      color: state.color,
      createdAt: Date.now(),
      isDefault: signatures.length === 0,
    };

    await saveSignature(signature, blob);

    // Also store in sessionStorage for immediate use
    const reader = new FileReader();
    reader.onload = () => {
      sessionStorage.setItem(
        'champdf-generated-signature',
        reader.result as string
      );
      // Navigate to sign-pdf
      window.location.href = `${import.meta.env.BASE_URL}sign-pdf.html`;
    };
    reader.onerror = () => {
      console.error('Failed to read signature blob');
      alert('Failed to prepare signature. Please try again.');
    };
    reader.readAsDataURL(blob);
  } catch (error) {
    console.error('Failed to use signature in Sign PDF:', error);
    alert('Failed to generate signature. Please try again.');
  }
}
