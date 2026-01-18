/**
 * Annotation Layer - Manages draggable/resizable annotation overlays
 */

import type { Annotation } from './types.js';

export class AnnotationLayer {
  private container: HTMLElement;
  private annotations: Map<string, HTMLElement> = new Map();
  private selectedId: string | null = null;
  private onUpdate: (annotation: Annotation) => void;
  private onSelect: (id: string | null) => void;

  constructor(
    container: HTMLElement,
    onUpdate: (annotation: Annotation) => void,
    onSelect: (id: string | null) => void
  ) {
    this.container = container;
    this.onUpdate = onUpdate;
    this.onSelect = onSelect;
    this.setupContainerEvents();
  }

  private setupContainerEvents() {
    // Deselect when clicking container background
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) {
        this.select(null);
      }
    });
  }

  addAnnotation(annotation: Annotation): HTMLElement {
    const el = document.createElement('div');
    el.id = `annotation-${annotation.id}`;
    el.className =
      'annotation-box absolute cursor-move border-2 border-transparent hover:border-orange-400 transition-colors';
    el.style.left = `${annotation.x}%`;
    el.style.top = `${annotation.y}%`;
    el.style.width = `${annotation.width}%`;
    el.style.height = `${annotation.height}%`;

    // Render content based on type
    this.renderAnnotationContent(el, annotation);

    this.makeDraggable(el, annotation);
    this.makeSelectable(el, annotation);
    this.addResizeHandles(el, annotation);

    this.container.appendChild(el);
    this.annotations.set(annotation.id, el);
    return el;
  }

  private renderAnnotationContent(el: HTMLElement, annotation: Annotation) {
    if (annotation.type === 'signature' && annotation.data.imageUrl) {
      el.innerHTML = `<img src="${annotation.data.imageUrl}" class="w-full h-full object-contain pointer-events-none" alt="Signature">`;
    } else if (annotation.type === 'initials') {
      if (annotation.data.imageUrl) {
        el.innerHTML = `<img src="${annotation.data.imageUrl}" class="w-full h-full object-contain pointer-events-none" alt="Initials">`;
      } else {
        // Render initials as editable text input in signature style
        const initials = annotation.data.text || '';
        el.innerHTML = `
          <div class="w-full h-full flex items-center justify-center bg-white/90 border-2 border-indigo-400 rounded">
            <input type="text"
              value="${initials}"
              placeholder="AB"
              maxlength="4"
              class="w-full h-full text-center text-2xl bg-transparent border-none outline-none text-indigo-800 pointer-events-auto uppercase"
              style="font-family: 'Dancing Script', cursive, serif;"
            >
          </div>
        `;
        // Handle input changes
        const input = el.querySelector('input');
        input?.addEventListener('input', (e) => {
          annotation.data.text = (
            e.target as HTMLInputElement
          ).value.toUpperCase();
          this.onUpdate(annotation);
        });
        input?.addEventListener('click', (e) => e.stopPropagation());
        input?.addEventListener('mousedown', (e) => e.stopPropagation());
      }
    } else if (annotation.type === 'date') {
      el.innerHTML = `<div class="w-full h-full flex items-center justify-center bg-yellow-100/80 border border-yellow-400 rounded text-sm text-gray-800 px-2">${annotation.data.text || new Date().toLocaleDateString()}</div>`;
    } else if (annotation.type === 'text') {
      el.innerHTML = `<div class="w-full h-full flex items-center bg-blue-100/80 border border-blue-400 rounded text-sm text-gray-800 px-2">${annotation.data.text || 'Text'}</div>`;
    } else if (annotation.type === 'checkbox') {
      const checked = annotation.data.checked ? 'checked' : '';
      el.innerHTML = `<div class="w-full h-full flex items-center justify-center bg-white border border-gray-400 rounded">
        <input type="checkbox" ${checked} class="w-5 h-5 pointer-events-auto cursor-pointer">
      </div>`;
      // Handle checkbox changes
      const checkbox = el.querySelector('input');
      checkbox?.addEventListener('change', (e) => {
        annotation.data.checked = (e.target as HTMLInputElement).checked;
        this.onUpdate(annotation);
      });
    }
  }

  private makeDraggable(el: HTMLElement, annotation: Annotation) {
    let isDragging = false;
    let startX = 0,
      startY = 0;
    let startLeft = 0,
      startTop = 0;

    const onMouseDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).classList.contains('resize-handle')) return;
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = annotation.x;
      startTop = annotation.y;
      el.classList.add('cursor-grabbing');
      e.preventDefault();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const containerRect = this.container.getBoundingClientRect();
      const dx = ((e.clientX - startX) / containerRect.width) * 100;
      const dy = ((e.clientY - startY) / containerRect.height) * 100;

      annotation.x = Math.max(
        0,
        Math.min(100 - annotation.width, startLeft + dx)
      );
      annotation.y = Math.max(
        0,
        Math.min(100 - annotation.height, startTop + dy)
      );

      el.style.left = `${annotation.x}%`;
      el.style.top = `${annotation.y}%`;
    };

    const onMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        el.classList.remove('cursor-grabbing');
        this.onUpdate(annotation);
      }
    };

    el.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  private makeSelectable(el: HTMLElement, annotation: Annotation) {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      e.stopPropagation();
      this.select(annotation.id);
    });
  }

  select(id: string | null) {
    // Deselect previous
    if (this.selectedId) {
      const prevEl = this.annotations.get(this.selectedId);
      prevEl?.classList.remove('ring-2', 'ring-orange-500', 'selected');
    }

    this.selectedId = id;

    // Select new
    if (id) {
      const el = this.annotations.get(id);
      el?.classList.add('ring-2', 'ring-orange-500', 'selected');
    }

    this.onSelect(id);
  }

  removeAnnotation(id: string) {
    const el = this.annotations.get(id);
    el?.remove();
    this.annotations.delete(id);
    if (this.selectedId === id) {
      this.selectedId = null;
      this.onSelect(null);
    }
  }

  private addResizeHandles(el: HTMLElement, annotation: Annotation) {
    const handle = document.createElement('div');
    handle.className =
      'resize-handle absolute bottom-0 right-0 w-3 h-3 bg-orange-500 cursor-se-resize rounded-tl';
    el.appendChild(handle);

    let isResizing = false;
    let startX = 0,
      startY = 0;
    let startWidth = 0,
      startHeight = 0;

    handle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startWidth = annotation.width;
      startHeight = annotation.height;
      e.stopPropagation();
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const containerRect = this.container.getBoundingClientRect();
      const dw = ((e.clientX - startX) / containerRect.width) * 100;
      const dh = ((e.clientY - startY) / containerRect.height) * 100;

      annotation.width = Math.max(
        5,
        Math.min(100 - annotation.x, startWidth + dw)
      );
      annotation.height = Math.max(
        3,
        Math.min(100 - annotation.y, startHeight + dh)
      );

      el.style.width = `${annotation.width}%`;
      el.style.height = `${annotation.height}%`;
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        this.onUpdate(annotation);
      }
    });
  }

  updateAnnotationContent(annotation: Annotation) {
    const el = this.annotations.get(annotation.id);
    if (el) {
      // Clear existing content except resize handle
      const handle = el.querySelector('.resize-handle');
      el.innerHTML = '';
      this.renderAnnotationContent(el, annotation);
      if (handle) el.appendChild(handle);
    }
  }

  clear() {
    this.annotations.forEach((el) => el.remove());
    this.annotations.clear();
    this.selectedId = null;
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }
}
