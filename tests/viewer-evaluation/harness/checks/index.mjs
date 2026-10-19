// One check module per family; each receives the runner context and { full, skipLarge }.
import pdf from './pdf.mjs';
import image from './image.mjs';
import word from './word.mjs';
import sheet from './sheet.mjs';
import email from './email.mjs';
import media from './media.mjs';
import archive from './archive.mjs';
import containment from './containment.mjs';
import importclass from './importclass.mjs';
import readiness from './readiness.mjs';

export const CHECKS = { pdf, image, word, sheet, email, media, archive, containment, importclass, readiness };
