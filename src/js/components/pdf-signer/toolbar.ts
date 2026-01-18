/**
 * Signer Toolbar - Left sidebar with signature and field tools
 */

import { createIcons, icons } from 'lucide';
import { getAllSignaturesWithImages } from '../../utils/signature-storage.js';
import { openSignatureLibrary } from '../../utils/signature-library-init.js';

export type AnnotationType =
  | 'signature'
  | 'date'
  | 'text'
  | 'initials'
  | 'checkbox';

export interface ToolbarCallbacks {
  onAddAnnotation: (type: AnnotationType, data?: { imageUrl?: string }) => void;
  onDeleteSelected: () => void;
}

export class SignerToolbar {
  private container: HTMLElement;
  private callbacks: ToolbarCallbacks;
  private hasSelection = false;

  constructor(container: HTMLElement, callbacks: ToolbarCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
  }

  async render() {
    const signaturesWithImages = await getAllSignaturesWithImages();

    this.container.innerHTML = `
      <div class="p-4 space-y-4">
        <h3 class="text-white font-medium text-sm">Add Fields</h3>

        <!-- Signatures Section -->
        <div class="space-y-2">
          <p class="text-gray-400 text-xs uppercase tracking-wide">Signatures</p>
          <div id="signature-tools" class="space-y-2">
            ${
              signaturesWithImages.length === 0
                ? `<p class="text-gray-500 text-xs py-2">No saved signatures</p>`
                : signaturesWithImages
                    .map(
                      ({ signature, imageUrl }) => `
              <div class="signature-drag-item bg-gray-700 rounded p-2 cursor-grab hover:bg-gray-600 transition-colors"
                   data-type="signature" data-image="${imageUrl}" draggable="true" title="Drag to place or click to add">
                <img src="${imageUrl}" alt="${signature.name}" class="w-full h-10 object-contain pointer-events-none">
              </div>
            `
                    )
                    .join('')
            }
          </div>
          <button id="add-new-signature" class="w-full text-xs text-orange-500 hover:text-orange-400 py-1 flex items-center justify-center gap-1">
            <i data-lucide="plus" class="w-3 h-3"></i>
            Create New Signature
          </button>
        </div>

        <!-- Other Tools -->
        <div class="space-y-2 pt-4 border-t border-gray-700">
          <p class="text-gray-400 text-xs uppercase tracking-wide">Other Fields</p>

          <button class="tool-btn w-full flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white text-sm p-2 rounded transition-colors"
                  data-type="date" title="Add current date">
            <i data-lucide="calendar" class="w-4 h-4"></i>
            Date
          </button>

          <button class="tool-btn w-full flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white text-sm p-2 rounded transition-colors"
                  data-type="text" title="Add text field">
            <i data-lucide="type" class="w-4 h-4"></i>
            Text Field
          </button>

          <button class="tool-btn w-full flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white text-sm p-2 rounded transition-colors"
                  data-type="initials" title="Add initials">
            <i data-lucide="pen-tool" class="w-4 h-4"></i>
            Initials
          </button>

          <button class="tool-btn w-full flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white text-sm p-2 rounded transition-colors"
                  data-type="checkbox" title="Add checkbox">
            <i data-lucide="check-square" class="w-4 h-4"></i>
            Checkbox
          </button>
        </div>

        <!-- Delete Selected -->
        <div class="pt-4 border-t border-gray-700">
          <button id="delete-selected-btn" class="w-full flex items-center gap-2 bg-red-900/30 hover:bg-red-900/50 text-red-400 text-sm p-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled title="Select an annotation to delete">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
            Delete Selected
          </button>
        </div>

        <!-- Help Text -->
        <div class="pt-4 border-t border-gray-700">
          <p class="text-xs text-gray-500 leading-relaxed">
            <strong class="text-gray-400">Tip:</strong> Drag signatures onto the PDF or click to add at center.
            Click to select, then drag to move or resize.
          </p>
        </div>
      </div>
    `;

    createIcons({ icons });
    this.setupEventListeners();
  }

  private setupEventListeners() {
    // Signature items - draggable
    this.container.querySelectorAll('.signature-drag-item').forEach((el) => {
      el.addEventListener('dragstart', (e) => {
        const target = e.currentTarget as HTMLElement;
        (e as DragEvent).dataTransfer?.setData(
          'application/json',
          JSON.stringify({
            type: 'signature',
            imageUrl: target.dataset.image,
          })
        );
        (e as DragEvent).dataTransfer!.effectAllowed = 'copy';
      });

      // Also handle click to add at center
      el.addEventListener('click', () => {
        const target = el as HTMLElement;
        this.callbacks.onAddAnnotation('signature', {
          imageUrl: target.dataset.image,
        });
      });
    });

    // Tool buttons
    this.container.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = (btn as HTMLElement).dataset.type as AnnotationType;
        if (type) {
          this.callbacks.onAddAnnotation(type);
        }
      });
    });

    // Add new signature
    this.container
      .querySelector('#add-new-signature')
      ?.addEventListener('click', () => {
        openSignatureLibrary((imageUrl) => {
          // When a new signature is created/selected, add it
          this.callbacks.onAddAnnotation('signature', { imageUrl });
        });
      });

    // Delete selected
    this.container
      .querySelector('#delete-selected-btn')
      ?.addEventListener('click', () => {
        this.callbacks.onDeleteSelected();
      });
  }

  setHasSelection(hasSelection: boolean) {
    this.hasSelection = hasSelection;
    const deleteBtn = this.container.querySelector(
      '#delete-selected-btn'
    ) as HTMLButtonElement;
    if (deleteBtn) {
      deleteBtn.disabled = !hasSelection;
    }
  }

  async refresh() {
    await this.render();
  }
}
