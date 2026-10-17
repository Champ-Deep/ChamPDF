/**
 * Signer Toolbar - Left sidebar with signature and field tools
 */

import { createIcons, icons } from 'lucide';
import { getAllSignaturesWithImages } from '../../utils/signature-storage.js';
import { openSignatureLibrary } from '../../utils/signature-library-init.js';
import { readSigningImage } from './image-background.js';
import { getTextStyle, TEXT_FONTS } from './text-style.js';
import type { Annotation, TextStyle } from './types.js';

export type AnnotationType =
  'signature' | 'date' | 'text' | 'initials' | 'checkbox';

export interface ToolbarCallbacks {
  onAddAnnotation: (type: AnnotationType, data?: { imageUrl?: string }) => void;
  onDeleteSelected: () => void;
  onUpdateTextStyle?: (style: Partial<TextStyle>) => void;
  onRemoveImageBackground?: (tolerance: number) => Promise<void>;
  onRestoreImageBackground?: () => void;
}

export class SignerToolbar {
  private container: HTMLElement;
  private callbacks: ToolbarCallbacks;
  private hasSelection = false;
  private selectedAnnotation: Annotation | null = null;
  private processing = false;
  private destroyed = false;

  constructor(container: HTMLElement, callbacks: ToolbarCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
  }

  async render() {
    const signaturesWithImages = await getAllSignaturesWithImages();
    if (this.destroyed) return;

    this.container.innerHTML = `
      <div class="p-4 space-y-4 [&_button]:min-h-11 [&_a]:min-h-11">
        <h3 class="text-white font-medium text-sm">Add Fields</h3>

        <!-- Signatures Section -->
        <div class="space-y-2">
          <p class="text-gray-400 text-xs uppercase tracking-wide">Signatures</p>
          <div id="signature-tools" class="space-y-2">
            ${
              signaturesWithImages.length === 0
                ? `<p class="text-gray-300 text-xs py-2">No saved signatures</p>`
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
          <label for="signing-image-input" class="block text-sm text-gray-200">Upload signature or logo (PNG/JPEG)</label>
          <input id="signing-image-input" type="file" accept="image/png,image/jpeg" class="hidden">
          <button id="upload-signing-image" class="w-full min-h-11 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded p-2">Choose image</button>
          <a href="${import.meta.env.BASE_URL}remove-watermark.html" target="_blank" rel="noopener" class="block text-sm text-orange-300 underline py-2">Remove an embedded PDF logo</a>
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
            Text Box
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
        <div id="text-properties" class="hidden space-y-3 pt-4 border-t border-gray-700">
          <h3 class="text-white text-sm font-medium">Selected Text Box</h3>
          <label for="text-font-family" class="block text-sm text-gray-200">Font</label>
          <select id="text-font-family" class="w-full bg-gray-700 text-white rounded p-2 min-h-11">
            ${Object.entries(TEXT_FONTS)
              .map(
                ([value, font]) =>
                  `<option value="${value}">${font.label}</option>`
              )
              .join('')}
          </select>
          <label for="text-font-size" class="block text-sm text-gray-200">Font size (pt)</label>
          <input id="text-font-size" type="number" min="6" max="72" step="1" class="w-full bg-gray-700 text-white rounded p-2 min-h-11">
          <label for="text-color" class="block text-sm text-gray-200">Text color</label>
          <input id="text-color" type="color" class="w-full min-h-11 bg-gray-700 rounded">
          <p class="text-xs text-gray-300">Type directly in the box. Drag its border to move, or its corner to resize. Enlarge the box if text overflows. PDF fonts support Latin text.</p>
        </div>
        <div id="image-properties" class="hidden space-y-3 pt-4 border-t border-gray-700">
          <h3 class="text-white text-sm font-medium">Selected Image</h3>
          <label for="background-tolerance" class="block text-sm text-gray-200">Light background tolerance (0 to 100)</label>
          <input id="background-tolerance" type="number" min="0" max="100" value="30" class="w-full bg-gray-700 text-white rounded p-2 min-h-11">
          <button id="remove-image-background" class="w-full min-h-11 text-white bg-gray-700 hover:bg-gray-600 rounded p-2 text-sm disabled:opacity-50">Remove light background</button>
          <button id="restore-image-background" class="w-full min-h-11 text-white bg-gray-700 hover:bg-gray-600 rounded p-2 text-sm disabled:opacity-50">Restore original image</button>
          <p class="text-xs text-gray-300">Makes white or light pixels transparent locally. It does not remove artwork already inside the PDF or colored backgrounds. The saved library image is unchanged.</p>
        </div>
        <p id="signer-tool-status" role="status" aria-live="polite" class="text-sm text-orange-200"></p>

        <div class="pt-4 border-t border-gray-700">
          <button id="delete-selected-btn" class="w-full flex items-center gap-2 bg-red-900/30 hover:bg-red-900/50 text-red-400 text-sm p-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled title="Select an annotation to delete">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
            Delete Selected
          </button>
        </div>

        <!-- Help Text -->
        <div class="pt-4 border-t border-gray-700">
          <p class="text-xs text-gray-300 leading-relaxed">
            <strong class="text-gray-400">Tip:</strong> Drag signatures onto the PDF or click to add at center.
            Click to select, then drag to move or resize.
          </p>
        </div>
      </div>
    `;

    createIcons({ icons });
    this.setupEventListeners();
    this.setSelection(this.selectedAnnotation);
  }

  private setupEventListeners() {
    const imageInput = this.container.querySelector(
      '#signing-image-input'
    ) as HTMLInputElement;
    this.container
      .querySelector('#upload-signing-image')
      ?.addEventListener('click', () => imageInput.click());
    imageInput?.addEventListener('change', async () => {
      const file = imageInput.files?.[0];
      if (!file) return;
      imageInput.disabled = true;
      try {
        const imageUrl = await readSigningImage(file);
        if (imageInput.isConnected)
          this.callbacks.onAddAnnotation('signature', { imageUrl });
        this.setStatus(
          'Image added. Select it to remove its light background.'
        );
      } catch (error) {
        this.setStatus(
          error instanceof Error ? error.message : 'Unable to load this image.'
        );
      } finally {
        imageInput.disabled = false;
        imageInput.value = '';
      }
    });
    this.container
      .querySelector('#text-font-family')
      ?.addEventListener('change', (e) => {
        this.callbacks.onUpdateTextStyle?.({
          fontFamily: (e.target as HTMLSelectElement)
            .value as TextStyle['fontFamily'],
        });
      });
    this.container
      .querySelector('#text-font-size')
      ?.addEventListener('change', (e) => {
        const input = e.target as HTMLInputElement;
        if (input.value && input.checkValidity())
          this.callbacks.onUpdateTextStyle?.({ fontSize: input.valueAsNumber });
        else this.setStatus('Enter a font size between 6 and 72 points.');
      });
    this.container
      .querySelector('#text-color')
      ?.addEventListener('input', (e) => {
        this.callbacks.onUpdateTextStyle?.({
          color: (e.target as HTMLInputElement).value,
        });
      });
    this.container
      .querySelector('#remove-image-background')
      ?.addEventListener('click', async () => {
        if (this.processing) return;
        const input = this.container.querySelector(
          '#background-tolerance'
        ) as HTMLInputElement;
        if (!input.value || !input.checkValidity()) {
          this.setStatus('Enter a tolerance between 0 and 100.');
          return;
        }
        this.processing = true;
        this.setSelection(this.selectedAnnotation);
        this.setStatus('Removing light background...');
        try {
          await this.callbacks.onRemoveImageBackground?.(input.valueAsNumber);
          this.setStatus(
            'Light background removed. Use Restore original image to undo.'
          );
        } catch (error) {
          this.setStatus(
            error instanceof Error
              ? error.message
              : 'Unable to remove the background.'
          );
        } finally {
          this.processing = false;
          this.setSelection(this.selectedAnnotation);
        }
      });
    this.container
      .querySelector('#restore-image-background')
      ?.addEventListener('click', () => {
        this.callbacks.onRestoreImageBackground?.();
        this.setStatus('Original image restored.');
      });

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

  setSelection(annotation: Annotation | null) {
    const changed = this.selectedAnnotation?.id !== annotation?.id;
    this.selectedAnnotation = annotation;
    this.setHasSelection(annotation !== null);
    this.container
      .querySelector('#text-properties')
      ?.classList.toggle('hidden', annotation?.type !== 'text');
    this.container
      .querySelector('#image-properties')
      ?.classList.toggle('hidden', !annotation?.data.imageUrl);
    if (
      annotation?.type === 'text' &&
      this.container.querySelector('#text-properties')
    ) {
      const style = getTextStyle(annotation.data);
      (
        this.container.querySelector('#text-font-family') as HTMLSelectElement
      ).value = style.fontFamily;
      (
        this.container.querySelector('#text-font-size') as HTMLInputElement
      ).value = String(style.fontSize);
      (this.container.querySelector('#text-color') as HTMLInputElement).value =
        style.color;
    }
    const remove = this.container.querySelector(
      '#remove-image-background'
    ) as HTMLButtonElement;
    const restore = this.container.querySelector(
      '#restore-image-background'
    ) as HTMLButtonElement;
    if (remove) remove.disabled = this.processing;
    if (restore)
      restore.disabled = this.processing || !annotation?.data.originalImageUrl;
    if (changed && annotation) {
      const panel = this.container.querySelector(
        annotation.type === 'text' ? '#text-properties' : '#image-properties'
      ) as HTMLElement;
      if (panel && !panel.classList.contains('hidden')) {
        this.container.scrollTop +=
          panel.getBoundingClientRect().top -
          this.container.getBoundingClientRect().top -
          16;
      }
    }
  }

  private setStatus(message: string) {
    const status = this.container.querySelector('#signer-tool-status');
    if (status) status.textContent = message;
  }

  destroy() {
    this.destroyed = true;
    this.container.innerHTML = '';
  }
}
