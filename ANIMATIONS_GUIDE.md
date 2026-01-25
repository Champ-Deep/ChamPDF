# chamPDF Animation System Guide

## Overview

chamPDF now features professional animations powered by **GSAP** (for complex animations and scroll effects) and **Motion One** (for performant micro-interactions). This guide shows you how to use these animations in your tool pages.

## Quick Start

### For Homepage (Already Integrated)

The homepage animations are automatically initialized in `main.ts`:

- Tool cards stagger on load
- Scroll reveals for category sections
- Animated category navigation
- Smooth scroll-to-top button
- Button and icon micro-interactions

### For Tool Pages

#### 1. Drop Zone Animation

Add this to any tool page's initialization function:

```typescript
import { initDropZoneAnimation } from '../animations/tool-page-animations.js';

function initializePage() {
  createIcons({ icons });

  // Initialize drop zone animation
  initDropZoneAnimation('drop-zone'); // Use your drop zone element ID

  // ... rest of your code
}
```

**What you get:**

- Continuous subtle pulse animation (idle state)
- Scale + glow on drag-over
- Success flash on file drop
- Smooth transitions between states

#### 2. File List Animations

Animate files when adding or removing from a list:

```typescript
import { animateFileRemoved } from '../animations/tool-page-animations.js';

// When removing a file
document.querySelectorAll('.remove-file-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    const index = parseInt(
      (e.currentTarget as HTMLElement).dataset.index || '0'
    );
    const fileEl = (e.currentTarget as HTMLElement).closest('.bg-gray-700');

    if (fileEl) {
      // Animate out, then update state
      animateFileRemoved(fileEl as HTMLElement, () => {
        state.files.splice(index, 1);
        updateFileList();
      });
    }
  });
});
```

#### 3. Success Celebrations

Add a celebration animation when processing completes:

```typescript
import { celebrateSuccess } from '../animations/modal-animations.js';

function showResults() {
  document.getElementById('download-section')?.classList.remove('hidden');

  const downloadSection = document.getElementById('download-section');
  if (downloadSection) {
    celebrateSuccess(downloadSection);
  }
}
```

**What you get:**

- Particle burst effect (12 particles)
- Checkmark icon scale animation
- Orange color theme

#### 4. Error Shake Animation

Add a shake effect for errors:

```typescript
import { shakeError } from '../animations/modal-animations.js';

function handleError() {
  const errorElement = document.getElementById('error-message');
  if (errorElement) {
    shakeError(errorElement);
  }
}
```

## Available Animation Functions

### Homepage Animations (`homepage-animations.ts`)

```typescript
import {
  initToolCardsAnimation, // Stagger tool cards on load
  initScrollReveals, // Fade-in sections on scroll
  initScrollToTopButton, // Animated scroll-to-top
  updateActiveCategory, // Animated category nav
} from '../animations/homepage-animations.js';
```

### Tool Page Animations (`tool-page-animations.ts`)

```typescript
import {
  initDropZoneAnimation, // Pulse + drag-over effects
  animateFileAdded, // Fade-in file item
  animateFileRemoved, // Slide-out file item
  animateProgress, // Smooth progress bar
  animateCircularProgress, // Circular progress with counter
} from '../animations/tool-page-animations.js';
```

### Modal Animations (`modal-animations.ts`)

```typescript
import {
  showModalAnimated, // Show modal with animation
  hideModalAnimated, // Hide modal with animation
  celebrateSuccess, // Particle burst + icon scale
  shakeError, // Horizontal shake
  pulseAttention, // Pulse for attention
} from '../animations/modal-animations.js';
```

### Micro-Interactions (`micro-interactions.ts`)

```typescript
import {
  initButtonAnimations, // Press-down effect
  initIconAnimations, // Scale + rotate on hover
  initSearchAnimations, // Focus glow effect
  initAllMicroInteractions, // Initialize all at once
} from '../animations/micro-interactions.js';
```

### Utilities (`utils.ts`)

```typescript
import {
  shouldReduceMotion, // Check user preference
  getAnimationConfig, // Apply reduced motion settings
  cleanupAnimations, // Kill all animations
  enableGPUAcceleration, // Force GPU rendering
  disableGPUAcceleration, // Remove GPU hint
} from '../animations/utils.ts';
```

## Modal Animations (Already Integrated in ui.ts)

The modal system is already animated! The following functions now use animations:

- `showLoader()` - Fade-in animation
- `hideLoader()` - Fade-out animation
- `showAlert()` - Bounce animation for errors, scale for others
- `hideAlert()` - Smooth fade-out

**Progress bar updates are now animated:**

```typescript
showLoader('Processing...', 50); // Progress animates smoothly to 50%
```

## CSS Animation Classes

Use these utility classes in your HTML for simple animations:

### Fade Animations

```html
<div class="fade-in">Fades in</div>
<div class="fade-out">Fades out</div>
```

### Scale Animation

```html
<div class="scale-in">Scales in with bounce</div>
```

### Slide Animation

```html
<div class="slide-up">Slides up</div>
```

### Stagger Delays

```html
<div class="animate-in stagger-1">Appears first</div>
<div class="animate-in stagger-2">Appears second</div>
<div class="animate-in stagger-3">Appears third</div>
```

### Pulse Attention

```html
<button class="pulse-attention">Notice me!</button>
```

## Custom Easing Variables

Use these CSS variables for consistent easing:

```css
:root {
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out-circ: cubic-bezier(0.85, 0, 0.15, 1);
  --ease-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);
}

/* Example usage */
.my-element {
  transition: all 0.6s var(--ease-out-expo);
}
```

## Complete Tool Page Example

Here's a complete example integrating all animations:

```typescript
import { createIcons, icons } from 'lucide';
import { showAlert, showLoader, hideLoader } from '../ui.js';
import {
  initDropZoneAnimation,
  animateFileRemoved,
} from '../animations/tool-page-animations.js';
import { celebrateSuccess } from '../animations/modal-animations.js';

function initializePage() {
  createIcons({ icons });

  // 1. Initialize drop zone animation
  const dropZoneCleanup = initDropZoneAnimation('drop-zone');

  // 2. File upload handling
  const fileInput = document.getElementById('file-input');
  fileInput?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files) handleFiles(Array.from(input.files));
  });

  // 3. Remove file with animation
  document.querySelectorAll('.remove-file-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const fileEl = (e.currentTarget as HTMLElement).closest('.file-item');
      if (fileEl) {
        animateFileRemoved(fileEl as HTMLElement, () => {
          // Remove from state after animation
          removeFile(index);
        });
      }
    });
  });

  // 4. Process with loader animation
  document
    .getElementById('process-btn')
    ?.addEventListener('click', async () => {
      showLoader('Processing your files...', 0);

      try {
        const result = await processFiles();

        hideLoader();
        showResults();

        // 5. Celebrate success
        const resultSection = document.getElementById('result-section');
        if (resultSection) {
          celebrateSuccess(resultSection);
        }
      } catch (error) {
        hideLoader();
        showAlert('Error', 'Processing failed', 'error');
      }
    });

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (dropZoneCleanup) dropZoneCleanup();
  });
}
```

## Accessibility

All animations respect the `prefers-reduced-motion` media query. Users who prefer reduced motion will see near-instant animations (0.01s duration).

The system automatically checks for this preference and adjusts animations accordingly - no extra code needed!

## Performance Tips

1. **GPU Acceleration**: Elements with animations automatically get `will-change` and `translateZ(0)`
2. **Cleanup**: Always cleanup animations on page unload using `cleanupAnimations()`
3. **Lazy Loading**: Scroll animations only initialize when elements enter the viewport
4. **Reduced Motion**: Automatically applied - no performance impact for users who prefer it

## Migration Guide for Existing Tool Pages

To add animations to an existing tool page:

1. **Import animations at the top:**

   ```typescript
   import { initDropZoneAnimation } from '../animations/tool-page-animations.js';
   ```

2. **Initialize in your init function:**

   ```typescript
   function initializePage() {
     createIcons({ icons });
     initDropZoneAnimation('drop-zone'); // Add this line
     // ... rest of your code
   }
   ```

3. **Remove manual drag-over handlers** (optional - animation handles it):

   ```typescript
   // DELETE THESE - handled by initDropZoneAnimation
   dropZone.addEventListener('dragover', (e) => {
     e.preventDefault();
     dropZone.classList.add('bg-gray-700');
   });

   dropZone.addEventListener('dragleave', () => {
     dropZone.classList.remove('bg-gray-700');
   });
   ```

4. **Keep the drop handler** for file processing:
   ```typescript
   // KEEP THIS
   dropZone.addEventListener('drop', (e) => {
     e.preventDefault();
     const files = e.dataTransfer?.files;
     if (files) handleFiles(Array.from(files));
   });
   ```

That's it! Your tool page now has professional animations.

## Example Tool Pages

See these files for complete examples:

- **[src/js/logic/remove-bg-page.ts](src/js/logic/remove-bg-page.ts)** - Drop zone + file animations
- **[src/js/main.ts](src/js/main.ts)** - Homepage animations integration

## Bundle Size Impact

- GSAP: ~50KB gzipped
- Motion One: ~6KB gzipped
- **Total: ~56KB** (acceptable for professional UX)

Both libraries are tree-shakeable, so only imported functions add to bundle size.

---

For questions or issues, see the main implementation plan at `.claude/plans/polished-chasing-glade.md`
