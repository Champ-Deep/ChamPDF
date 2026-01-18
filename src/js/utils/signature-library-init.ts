/**
 * Signature Library Modal Initialization
 * Handles the global signature library modal functionality
 */

import { createIcons, icons } from 'lucide';
import {
  getSignatures,
  getSignatureImage,
  deleteSignature,
  setDefaultSignature,
  saveSignature,
  getAllSignaturesWithImages,
  type SavedSignature,
} from './signature-storage.js';

// Import signature fonts for the create panel
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

const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 200;
const DEVICE_PIXEL_RATIO = 2;

interface CreateState {
  name: string;
  selectedStyle: string;
  color: string;
}

const createState: CreateState = {
  name: '',
  selectedStyle: 'dancing',
  color: '#1a365d',
};

let selectedSignatureId: string | null = null;
let onSelectCallback: ((imageUrl: string) => void) | null = null;

export function initSignatureLibraryModal() {
  const modal = document.getElementById('signature-library-modal');
  if (!modal) return;

  const openBtn = document.getElementById('open-signatures-btn');
  const openBtnMobile = document.getElementById('open-signatures-btn-mobile');
  const closeBtn = document.getElementById('close-signature-library');
  const backdrop = document.getElementById('signature-library-backdrop');
  const cancelBtn = document.getElementById('signature-library-cancel');
  const useBtn = document.getElementById('signature-library-use');
  const tabSaved = document.getElementById('tab-saved-signatures');
  const tabCreate = document.getElementById('tab-create-signature');

  // Open modal
  openBtn?.addEventListener('click', () => openSignatureLibrary());
  openBtnMobile?.addEventListener('click', () => openSignatureLibrary());

  // Close modal handlers
  const closeModal = () => {
    modal.classList.add('hidden');
    selectedSignatureId = null;
    updateUseButtonState();
  };

  closeBtn?.addEventListener('click', closeModal);
  backdrop?.addEventListener('click', closeModal);
  cancelBtn?.addEventListener('click', closeModal);

  // Use selected signature
  useBtn?.addEventListener('click', async () => {
    if (selectedSignatureId && onSelectCallback) {
      const blob = await getSignatureImage(selectedSignatureId);
      if (blob) {
        const imageUrl = URL.createObjectURL(blob);
        onSelectCallback(imageUrl);
      }
    }
    closeModal();
  });

  // Tab switching
  tabSaved?.addEventListener('click', () => switchToTab('saved'));
  tabCreate?.addEventListener('click', () => switchToTab('create'));

  // Initialize create panel
  initCreatePanel();
}

export function openSignatureLibrary(
  callback?: (imageUrl: string) => void
): void {
  const modal = document.getElementById('signature-library-modal');
  if (!modal) return;

  onSelectCallback = callback || null;
  selectedSignatureId = null;

  modal.classList.remove('hidden');
  switchToTab('saved');
  renderSignaturesList();
  createIcons({ icons });
}

function switchToTab(tab: 'saved' | 'create') {
  const tabSaved = document.getElementById('tab-saved-signatures');
  const tabCreate = document.getElementById('tab-create-signature');
  const panelSaved = document.getElementById('saved-signatures-panel');
  const panelCreate = document.getElementById('create-signature-panel');
  const useBtn = document.getElementById('signature-library-use');

  if (tab === 'saved') {
    tabSaved?.classList.add(
      'text-orange-500',
      'border-b-2',
      'border-orange-500'
    );
    tabSaved?.classList.remove('text-gray-400');
    tabCreate?.classList.remove(
      'text-orange-500',
      'border-b-2',
      'border-orange-500'
    );
    tabCreate?.classList.add('text-gray-400');
    panelSaved?.classList.remove('hidden');
    panelCreate?.classList.add('hidden');
    if (useBtn) useBtn.textContent = 'Use Selected';
    updateUseButtonState();
  } else {
    tabCreate?.classList.add(
      'text-orange-500',
      'border-b-2',
      'border-orange-500'
    );
    tabCreate?.classList.remove('text-gray-400');
    tabSaved?.classList.remove(
      'text-orange-500',
      'border-b-2',
      'border-orange-500'
    );
    tabSaved?.classList.add('text-gray-400');
    panelCreate?.classList.remove('hidden');
    panelSaved?.classList.add('hidden');
    if (useBtn) useBtn.textContent = 'Save Signature';
    updateCreateButtonState();
  }
}

async function renderSignaturesList() {
  const grid = document.getElementById('signatures-grid');
  const noSigMsg = document.getElementById('no-signatures-msg');

  if (!grid) return;

  grid.innerHTML = '';
  selectedSignatureId = null;
  updateUseButtonState();

  const signaturesWithImages = await getAllSignaturesWithImages();

  if (signaturesWithImages.length === 0) {
    noSigMsg?.classList.remove('hidden');
    return;
  }

  noSigMsg?.classList.add('hidden');

  for (const { signature, imageUrl } of signaturesWithImages) {
    const card = document.createElement('div');
    card.className =
      'signature-card bg-gray-700 rounded-lg p-3 cursor-pointer hover:bg-gray-600 transition-colors relative group';
    card.dataset.signatureId = signature.id;

    card.innerHTML = `
      <img src="${imageUrl}" alt="${signature.name}" class="w-full h-16 object-contain mb-2 pointer-events-none">
      <p class="text-sm text-white truncate">${signature.name}</p>
      <p class="text-xs text-gray-400">${new Date(signature.createdAt).toLocaleDateString()}</p>
      ${signature.isDefault ? '<span class="absolute top-2 right-2 text-xs bg-orange-600 text-white px-1.5 py-0.5 rounded">Default</span>' : ''}
      <button class="delete-signature-btn absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-600 rounded" title="Delete">
        <i data-lucide="trash-2" class="w-4 h-4 text-red-400 hover:text-white"></i>
      </button>
    `;

    // Select signature on click
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.delete-signature-btn')) return;

      document.querySelectorAll('.signature-card').forEach((c) => {
        c.classList.remove('ring-2', 'ring-orange-500');
      });
      card.classList.add('ring-2', 'ring-orange-500');
      selectedSignatureId = signature.id;
      updateUseButtonState();
    });

    // Delete button
    const deleteBtn = card.querySelector('.delete-signature-btn');
    deleteBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete signature "${signature.name}"?`)) {
        await deleteSignature(signature.id);
        URL.revokeObjectURL(imageUrl);
        renderSignaturesList();
      }
    });

    grid.appendChild(card);
  }

  createIcons({ icons });
}

function updateUseButtonState() {
  const useBtn = document.getElementById(
    'signature-library-use'
  ) as HTMLButtonElement;
  if (useBtn && useBtn.textContent === 'Use Selected') {
    useBtn.disabled = !selectedSignatureId;
  }
}

function updateCreateButtonState() {
  const useBtn = document.getElementById(
    'signature-library-use'
  ) as HTMLButtonElement;
  if (useBtn && useBtn.textContent === 'Save Signature') {
    useBtn.disabled = createState.name.trim().length === 0;
  }
}

function initCreatePanel() {
  const panel = document.getElementById('create-signature-panel');
  if (!panel) return;

  // Build create panel HTML
  panel.innerHTML = `
    <div class="space-y-4">
      <!-- Name Input -->
      <div>
        <label for="sig-name-input" class="block text-sm font-medium text-gray-300 mb-2">Your Name</label>
        <input
          type="text"
          id="sig-name-input"
          placeholder="Enter your full name"
          class="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500"
        >
      </div>

      <!-- Style Selection -->
      <div>
        <label class="block text-sm font-medium text-gray-300 mb-2">Choose Style</label>
        <div id="sig-styles-grid" class="grid grid-cols-2 gap-3">
          <!-- Populated dynamically -->
        </div>
      </div>

      <!-- Color Selection -->
      <div>
        <label class="block text-sm font-medium text-gray-300 mb-2">Signature Color</label>
        <div class="flex gap-3">
          <button class="sig-color-btn w-10 h-10 rounded-full border-2 border-gray-600" data-color="#1a365d" style="background-color: #1a365d" title="Navy Blue"></button>
          <button class="sig-color-btn w-10 h-10 rounded-full border-2 border-gray-600" data-color="#000000" style="background-color: #000000" title="Black"></button>
          <button class="sig-color-btn w-10 h-10 rounded-full border-2 border-gray-600" data-color="#1e3a5f" style="background-color: #1e3a5f" title="Dark Blue"></button>
          <button class="sig-color-btn w-10 h-10 rounded-full border-2 border-gray-600" data-color="#7c2d12" style="background-color: #7c2d12" title="Brown"></button>
        </div>
      </div>

      <!-- Preview -->
      <div>
        <label class="block text-sm font-medium text-gray-300 mb-2">Preview</label>
        <div class="bg-gray-900 rounded-lg p-4">
          <canvas id="sig-preview-canvas" class="w-full" style="height: 80px;"></canvas>
        </div>
      </div>
    </div>
  `;

  // Setup style selection
  const stylesGrid = document.getElementById('sig-styles-grid');
  if (stylesGrid) {
    SIGNATURE_STYLES.forEach((style) => {
      const styleBtn = document.createElement('button');
      styleBtn.className = `sig-style-btn p-3 rounded-lg border-2 text-left transition-colors ${
        createState.selectedStyle === style.id
          ? 'border-orange-500 bg-gray-700'
          : 'border-gray-600 bg-gray-800 hover:border-gray-500'
      }`;
      styleBtn.dataset.styleId = style.id;
      styleBtn.innerHTML = `
        <span class="block text-white text-lg" style="font-family: '${style.fontFamily}', cursive;">${style.name}</span>
        <span class="block text-xs text-gray-400">${style.description}</span>
      `;
      styleBtn.addEventListener('click', () => {
        createState.selectedStyle = style.id;
        updateStyleSelection();
        renderPreview();
      });
      stylesGrid.appendChild(styleBtn);
    });
  }

  // Setup name input
  const nameInput = document.getElementById(
    'sig-name-input'
  ) as HTMLInputElement;
  nameInput?.addEventListener('input', (e) => {
    createState.name = (e.target as HTMLInputElement).value;
    renderPreview();
    updateCreateButtonState();
  });

  // Setup color selection
  const colorBtns = panel.querySelectorAll('.sig-color-btn');
  colorBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      createState.color = (btn as HTMLElement).dataset.color || '#1a365d';
      updateColorSelection();
      renderPreview();
    });
  });

  // Initial render
  updateStyleSelection();
  updateColorSelection();
  renderPreview();

  // Override use button for create tab
  const useBtn = document.getElementById('signature-library-use');
  useBtn?.addEventListener('click', async () => {
    const tabCreate = document.getElementById('tab-create-signature');
    if (tabCreate?.classList.contains('text-orange-500')) {
      await saveNewSignature();
    }
  });
}

function updateStyleSelection() {
  const styleBtns = document.querySelectorAll('.sig-style-btn');
  styleBtns.forEach((btn) => {
    const styleId = (btn as HTMLElement).dataset.styleId;
    if (styleId === createState.selectedStyle) {
      btn.classList.remove('border-gray-600', 'bg-gray-800');
      btn.classList.add('border-orange-500', 'bg-gray-700');
    } else {
      btn.classList.add('border-gray-600', 'bg-gray-800');
      btn.classList.remove('border-orange-500', 'bg-gray-700');
    }
  });
}

function updateColorSelection() {
  const colorBtns = document.querySelectorAll('.sig-color-btn');
  colorBtns.forEach((btn) => {
    const color = (btn as HTMLElement).dataset.color;
    if (color === createState.color) {
      btn.classList.remove('border-gray-600');
      btn.classList.add('border-orange-500', 'ring-2', 'ring-orange-500');
    } else {
      btn.classList.add('border-gray-600');
      btn.classList.remove('border-orange-500', 'ring-2', 'ring-orange-500');
    }
  });
}

function renderPreview() {
  const canvas = document.getElementById(
    'sig-preview-canvas'
  ) as HTMLCanvasElement;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const style = SIGNATURE_STYLES.find(
    (s) => s.id === createState.selectedStyle
  );
  if (!style) return;

  // Set canvas resolution
  canvas.width = CANVAS_WIDTH * DEVICE_PIXEL_RATIO;
  canvas.height = CANVAS_HEIGHT * DEVICE_PIXEL_RATIO;
  ctx.scale(DEVICE_PIXEL_RATIO, DEVICE_PIXEL_RATIO);

  // Clear canvas
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const displayName = createState.name || 'Your Name';
  const fontSize = 48;

  ctx.font = `${fontSize}px "${style.fontFamily}", cursive`;
  ctx.fillStyle = createState.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  ctx.fillText(displayName, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
}

async function saveNewSignature() {
  if (!createState.name.trim()) return;

  const style = SIGNATURE_STYLES.find(
    (s) => s.id === createState.selectedStyle
  );
  if (!style) return;

  // Generate PNG blob
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = CANVAS_WIDTH * DEVICE_PIXEL_RATIO;
  exportCanvas.height = CANVAS_HEIGHT * DEVICE_PIXEL_RATIO;

  const ctx = exportCanvas.getContext('2d');
  if (!ctx) return;

  ctx.scale(DEVICE_PIXEL_RATIO, DEVICE_PIXEL_RATIO);

  const fontSize = 48;
  ctx.font = `${fontSize}px "${style.fontFamily}", cursive`;
  ctx.fillStyle = createState.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(createState.name, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);

  const blob = await new Promise<Blob>((resolve, reject) => {
    exportCanvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to create blob'));
      },
      'image/png',
      1.0
    );
  });

  const signatures = getSignatures();
  const signature: SavedSignature = {
    id: crypto.randomUUID(),
    name: createState.name,
    style: createState.selectedStyle,
    color: createState.color,
    createdAt: Date.now(),
    isDefault: signatures.length === 0,
  };

  await saveSignature(signature, blob);

  // Reset form
  createState.name = '';
  const nameInput = document.getElementById(
    'sig-name-input'
  ) as HTMLInputElement;
  if (nameInput) nameInput.value = '';
  renderPreview();

  // Switch to saved tab and refresh
  switchToTab('saved');
  renderSignaturesList();
}
