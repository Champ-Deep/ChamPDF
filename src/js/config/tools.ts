// This file centralizes the definition of all available tools, organized by category.
export const categories = [
  {
    name: 'PDF Essentials',
    tools: [
      {
        href: import.meta.env.BASE_URL + 'pdf-multi-tool.html',
        name: 'PDF Multi Tool',
        icon: 'ph-pencil-ruler',
        subtitle:
          'Merge, Split, Organize, Delete, Rotate, Extract and Duplicate in one interface.',
      },
      {
        href: import.meta.env.BASE_URL + 'merge-pdf.html',
        name: 'Merge PDF',
        icon: 'ph-browsers',
        subtitle: 'Combine multiple PDFs into one file.',
      },
      {
        href: import.meta.env.BASE_URL + 'split-pdf.html',
        name: 'Split PDF',
        icon: 'ph-scissors',
        subtitle: 'Extract a range of pages into a new PDF.',
      },
      {
        href: import.meta.env.BASE_URL + 'compress-pdf.html',
        name: 'Compress PDF',
        icon: 'ph-lightning',
        subtitle: 'Reduce the file size of your PDF.',
      },
      {
        href: import.meta.env.BASE_URL + 'edit-pdf.html',
        name: 'PDF Editor',
        icon: 'ph-pencil-simple',
        subtitle: 'Annotate, highlight, redact, comment, and add shapes.',
      },
      {
        href: import.meta.env.BASE_URL + 'ocr-pdf.html',
        name: 'OCR PDF',
        icon: 'ph-barcode',
        subtitle: 'Make scanned PDFs searchable and copyable.',
      },
    ],
  },
  {
    name: 'Image & Media Tools',
    tools: [
      {
        href: import.meta.env.BASE_URL + 'remove-bg.html',
        name: 'Remove Background',
        icon: 'ph-magic-wand',
        subtitle: 'Instantly remove backgrounds from images.',
      },
      {
        href: import.meta.env.BASE_URL + 'video-rebrander.html',
        name: 'Video Logo Remover',
        icon: 'ph-video',
        subtitle: 'Remove watermarks and rebrand videos.',
      },
      {
        href: import.meta.env.BASE_URL + 'remove-watermark.html',
        name: 'PDF Watermark Remover',
        icon: 'ph-file-x',
        subtitle: 'Remove watermarks from PDFs (Optimized for Notebook LM).',
      },
      {
        href: import.meta.env.BASE_URL + 'image-to-pdf.html',
        name: 'Images to PDF',
        icon: 'ph-images',
        subtitle: 'Convert JPG, PNG, WebP, SVG, and more to PDF.',
      },
      {
        href: import.meta.env.BASE_URL + 'pdf-to-jpg.html',
        name: 'PDF to JPG',
        icon: 'ph-file-image',
        subtitle: 'Convert PDF pages into JPG images.',
      },
      {
        href: import.meta.env.BASE_URL + 'pdf-to-png.html',
        name: 'PDF to PNG',
        icon: 'ph-file-image',
        subtitle: 'Convert PDF pages into PNG images.',
      },
      {
        href: import.meta.env.BASE_URL + 'extract-images.html',
        name: 'Extract Images',
        icon: 'ph-download-simple',
        subtitle: 'Extract all embedded images from your PDF.',
      },
    ],
  },
  {
    name: 'Organize & Manage',
    tools: [
      {
        href: import.meta.env.BASE_URL + 'organize-pdf.html',
        name: 'Organize PDF',
        icon: 'ph-files',
        subtitle: 'Duplicate, reorder, and delete pages.',
      },
      {
        href: import.meta.env.BASE_URL + 'crop-pdf.html',
        name: 'Crop PDF',
        icon: 'ph-crop',
        subtitle: 'Trim the margins of your PDF.',
      },
      {
        href: import.meta.env.BASE_URL + 'rotate-pdf.html',
        name: 'Rotate PDF',
        icon: 'ph-arrow-clockwise',
        subtitle: 'Turn pages in 90-degree increments.',
      },
      {
        href: import.meta.env.BASE_URL + 'delete-pages.html',
        name: 'Delete Pages',
        icon: 'ph-trash',
        subtitle: 'Remove specific pages from your document.',
      },
      {
        href: import.meta.env.BASE_URL + 'page-numbers.html',
        name: 'Page Numbers',
        icon: 'ph-list-numbers',
        subtitle: 'Insert page numbers into your document.',
      },
      {
        href: import.meta.env.BASE_URL + 'add-watermark.html',
        name: 'Add Watermark',
        icon: 'ph-drop',
        subtitle: 'Stamp text or an image over your PDF.',
      },
      {
        href: import.meta.env.BASE_URL + 'header-footer.html',
        name: 'Header & Footer',
        icon: 'ph-paragraph',
        subtitle: 'Add text to the top and bottom of pages.',
      },
    ],
  },
  {
    name: 'Security & Privacy',
    tools: [
      {
        href: import.meta.env.BASE_URL + 'sign-pdf.html',
        name: 'Sign PDF',
        icon: 'ph-pen-nib',
        subtitle: 'Draw, type, or upload your signature.',
      },
      {
        href: import.meta.env.BASE_URL + 'encrypt-pdf.html',
        name: 'Encrypt PDF',
        icon: 'ph-lock',
        subtitle: 'Lock your PDF with a password.',
      },
      {
        href: import.meta.env.BASE_URL + 'decrypt-pdf.html',
        name: 'Decrypt PDF',
        icon: 'ph-lock-open',
        subtitle: 'Remove password protection from PDF.',
      },
      {
        href: import.meta.env.BASE_URL + 'sanitize-pdf.html',
        name: 'Sanitize PDF',
        icon: 'ph-broom',
        subtitle: 'Remove metadata, annotations, and hidden scripts.',
      },
      {
        href: import.meta.env.BASE_URL + 'remove-metadata.html',
        name: 'Remove Metadata',
        icon: 'ph-file-x',
        subtitle: 'Strip sensitive hidden data.',
      },
      {
        href: import.meta.env.BASE_URL + 'digital-sign-pdf.html',
        name: 'Digital Signature',
        icon: 'ph-certificate',
        subtitle: 'Add a cryptographic digital signature.',
      },
    ],
  },
  {
    name: 'Document Converters',
    tools: [
      {
        href: import.meta.env.BASE_URL + 'word-to-pdf.html',
        name: 'Word to PDF',
        icon: 'ph-microsoft-word-logo',
        subtitle: 'Convert DOCX, DOC to PDF.',
      },
      {
        href: import.meta.env.BASE_URL + 'excel-to-pdf.html',
        name: 'Excel to PDF',
        icon: 'ph-microsoft-excel-logo',
        subtitle: 'Convert XLSX, XLS to PDF.',
      },
      {
        href: import.meta.env.BASE_URL + 'powerpoint-to-pdf.html',
        name: 'PowerPoint to PDF',
        icon: 'ph-microsoft-powerpoint-logo',
        subtitle: 'Convert PPTX, PPT to PDF.',
      },
      {
        href: import.meta.env.BASE_URL + 'pdf-to-docx.html',
        name: 'PDF to Word',
        icon: 'ph-microsoft-word-logo',
        subtitle: 'Convert PDF to editable Word doc.',
      },
      {
        href: import.meta.env.BASE_URL + 'pdf-to-pptx.html',
        name: 'PDF to PowerPoint',
        icon: 'ph-microsoft-powerpoint-logo',
        subtitle: 'Convert PDF to PowerPoint slides.',
      },
      {
        href: import.meta.env.BASE_URL + 'markdown-to-pdf.html',
        name: 'Markdown to PDF',
        icon: 'ph-markdown-logo',
        subtitle: 'Convert Markdown to nicely formatted PDF.',
      },
      {
        href: import.meta.env.BASE_URL + 'text-to-pdf.html',
        name: 'Text to PDF',
        icon: 'ph-text-t',
        subtitle: 'Convert plain text to PDF.',
      },
      {
        href: import.meta.env.BASE_URL + 'pdf-to-text.html',
        name: 'PDF to Text',
        icon: 'ph-text-aa',
        subtitle: 'Extract text from PDF.',
      },
    ],
  },
  {
    name: 'Optimize & Repair',
    tools: [
      {
        href: import.meta.env.BASE_URL + 'repair-pdf.html',
        name: 'Repair PDF',
        icon: 'ph-wrench',
        subtitle: 'Recover data from corrupted PDFs.',
      },
      {
        href: import.meta.env.BASE_URL + 'linearize-pdf.html',
        name: 'Linearize PDF',
        icon: 'ph-gauge',
        subtitle: 'Optimize PDF for fast web viewing.',
      },
      {
        href: import.meta.env.BASE_URL + 'deskew-pdf.html',
        name: 'Deskew PDF',
        icon: 'ph-perspective',
        subtitle: 'Straighten tilted scanned pages.',
      },
      {
        href: import.meta.env.BASE_URL + 'font-to-outline.html',
        name: 'Font to Outline',
        icon: 'ph-text-outdent',
        subtitle: 'Convert fonts to vector outlines.',
      },
      {
        href: import.meta.env.BASE_URL + 'pdf-booklet.html',
        name: 'PDF Booklet',
        icon: 'ph-book-open',
        subtitle: 'Rearrange pages for booklet printing.',
      },
      {
        href: import.meta.env.BASE_URL + 'n-up-pdf.html',
        name: 'N-Up PDF',
        icon: 'ph-squares-four',
        subtitle: 'Arrange multiple pages onto one sheet.',
      },
    ],
  },
];
