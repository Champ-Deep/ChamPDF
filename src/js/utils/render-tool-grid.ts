import { createIcons, icons } from 'lucide';
import type { Category } from '../config/tools.js';
import { t } from '../i18n/index.js';

const categoryTranslationKeys: Record<string, string> = {
  'PDF Essentials': 'tools:categories.pdfEssentials',
  'Image & Media Tools': 'tools:categories.imageMedia',
  'Organize & Manage': 'tools:categories.organizeManage',
  'Security & Privacy': 'tools:categories.securityPrivacy',
  'Document Converters': 'tools:categories.documentConverters',
  'Optimize & Repair': 'tools:categories.optimizeRepair',
  'Image to PDF Converters': 'tools:categories.imageToPdfConverters',
  'Office to PDF Converters': 'tools:categories.officeToPdfConverters',
  'Forms & Data': 'tools:categories.formsData',
};

const toolTranslationKeys: Record<string, string> = {
  'PDF Multi Tool': 'tools:pdfMultiTool',
  'Merge PDF': 'tools:mergePdf',
  'Split PDF': 'tools:splitPdf',
  'Compress PDF': 'tools:compressPdf',
  'PDF Editor': 'tools:pdfEditor',
  'OCR PDF': 'tools:ocrPdf',
  'Remove Background': 'tools:removeBg',
  'Video Logo Remover': 'tools:videoRebrander',
  'Image Watermark Remover': 'tools:imageWatermarkRemover',
  'PDF Watermark Remover': 'tools:removeWatermark',
  'Images to PDF': 'tools:imageToPdf',
  'PDF to JPG': 'tools:pdfToJpg',
  'PDF to PNG': 'tools:pdfToPng',
  'Extract Images': 'tools:extractImages',
  'Organize PDF': 'tools:duplicateOrganize',
  'Crop PDF': 'tools:cropPdf',
  'Rotate PDF': 'tools:rotatePdf',
  'Delete Pages': 'tools:deletePages',
  'Page Numbers': 'tools:pageNumbers',
  'Add Watermark': 'tools:addWatermark',
  'Header & Footer': 'tools:headerFooter',
  'Sign PDF': 'tools:signPdf',
  'Encrypt PDF': 'tools:encryptPdf',
  'Decrypt PDF': 'tools:decryptPdf',
  'Sanitize PDF': 'tools:sanitizePdf',
  'Remove Metadata': 'tools:removeMetadata',
  'Digital Signature': 'tools:digitalSignPdf',
  'Word to PDF': 'tools:wordToPdf',
  'Excel to PDF': 'tools:excelToPdf',
  'PowerPoint to PDF': 'tools:powerpointToPdf',
  'PDF to Word': 'tools:pdfToDocx',
  'PDF to PowerPoint': 'tools:pdfToPptx',
  'Markdown to PDF': 'tools:markdownToPdf',
  'Text to PDF': 'tools:textToPdf',
  'PDF to Text': 'tools:pdfToText',
  'Repair PDF': 'tools:repairPdf',
  'Linearize PDF': 'tools:linearizePdf',
  'Deskew PDF': 'tools:deskewPdf',
  'Font to Outline': 'tools:fontToOutline',
  'PDF Booklet': 'tools:pdfBooklet',
  'N-Up PDF': 'tools:nUpPdf',
};

function getToolId(tool: { href?: string; name: string }): string {
  if (tool.href) {
    const match = tool.href.match(/\/([^/]+)\.html$/);
    return match ? match[1] : tool.href;
  }
  return tool.name.toLowerCase().replace(/\s+/g, '-');
}

export function renderToolGrid(
  filteredCategories: Category[],
  container: HTMLElement
): void {
  container.textContent = '';

  filteredCategories.forEach((category) => {
    const categoryId = category.name.toLowerCase().replace(/\s+/g, '-');
    const categoryGroup = document.createElement('div');
    categoryGroup.className = 'category-group col-span-full';
    categoryGroup.id = categoryId;

    const title = document.createElement('h2');
    title.className =
      'text-xl font-bold text-orange-400 mb-4 mt-8 first:mt-0 text-white';
    const categoryKey = categoryTranslationKeys[category.name];
    title.textContent = categoryKey ? t(categoryKey) : category.name;

    const toolsContainer = document.createElement('div');
    toolsContainer.className =
      'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 md:gap-6';

    category.tools.forEach((tool) => {
      let toolCard: HTMLDivElement | HTMLAnchorElement;

      if (tool.href) {
        toolCard = document.createElement('a');
        toolCard.href = tool.href;
        toolCard.className =
          'tool-card block bg-gray-800 rounded-xl p-4 cursor-pointer flex flex-col items-center justify-center text-center no-underline hover:shadow-lg transition duration-200';
      } else {
        toolCard = document.createElement('div');
        toolCard.className =
          'tool-card bg-gray-800 rounded-xl p-4 cursor-pointer flex flex-col items-center justify-center text-center hover:shadow-lg transition duration-200';
        (toolCard as HTMLElement).dataset.toolId = getToolId(tool);
      }

      const icon = document.createElement('i');
      if (tool.icon.startsWith('ph-')) {
        icon.className = `ph ${tool.icon} text-4xl mb-3 text-orange-400`;
      } else {
        icon.className = 'w-10 h-10 mb-3 text-orange-400';
        icon.setAttribute('data-lucide', tool.icon);
      }

      const toolName = document.createElement('h3');
      toolName.className = 'font-semibold text-white';
      const toolKey = toolTranslationKeys[tool.name];
      toolName.textContent = toolKey ? t(`${toolKey}.name`) : tool.name;

      toolCard.append(icon, toolName);

      if (tool.subtitle) {
        const toolSubtitle = document.createElement('p');
        toolSubtitle.className = 'text-xs text-gray-400 mt-1 px-2';
        toolSubtitle.textContent = toolKey
          ? t(`${toolKey}.subtitle`)
          : tool.subtitle;
        toolCard.appendChild(toolSubtitle);
      }

      toolsContainer.appendChild(toolCard);
    });

    categoryGroup.append(title, toolsContainer);
    container.appendChild(categoryGroup);
  });

  createIcons({ icons });
}
