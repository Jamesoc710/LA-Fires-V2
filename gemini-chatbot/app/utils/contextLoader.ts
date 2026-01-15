import fs from 'fs';
import path from 'path';

// Files to exclude from automatic loading (too large for every request)
const EXCLUDED_FILES = [
  'municode_title_26.txt',  // 567KB - causes ~175K tokens per request
  'municode_title_22.txt',  // If this exists, exclude it too
];

// Maximum file size to auto-load (in bytes) - ~50KB keeps us under 15K tokens
const MAX_FILE_SIZE = 50 * 1024;

export async function loadContext(): Promise<string> {
  try {
    const contextPath = path.join(process.cwd(), 'context', 'knowledge_base.txt');
    const contextData = fs.readFileSync(contextPath, 'utf8');
    return contextData;
  } catch (error) {
    console.error('Error loading context:', error);
    return 'Unable to load context information.';
  }
}

// Load all context files EXCEPT large ones
export async function loadAllContextFiles(): Promise<string> {
  try {
    const contextDir = path.join(process.cwd(), 'context');
    
    // Check if context directory exists
    if (!fs.existsSync(contextDir)) {
      console.warn('[contextLoader] No context directory found');
      return '';
    }
    
    const files = fs.readdirSync(contextDir);
    
    const contextContents: string[] = [];
    let totalSize = 0;
    
    for (const file of files) {
      // Skip non-txt files
      if (!file.endsWith('.txt')) continue;
      
      // Skip explicitly excluded files
      if (EXCLUDED_FILES.includes(file)) {
        console.log(`[contextLoader] Skipping excluded file: ${file}`);
        continue;
      }
      
      const filePath = path.join(contextDir, file);
      const stats = fs.statSync(filePath);
      
      // Skip files that are too large
      if (stats.size > MAX_FILE_SIZE) {
        console.log(`[contextLoader] Skipping large file: ${file} (${(stats.size / 1024).toFixed(1)} KB)`);
        continue;
      }
      
      const content = fs.readFileSync(filePath, 'utf8');
      contextContents.push(content);
      totalSize += stats.size;
      console.log(`[contextLoader] Loaded: ${file} (${(stats.size / 1024).toFixed(1)} KB)`);
    }
    
    console.log(`[contextLoader] Total context size: ${(totalSize / 1024).toFixed(1)} KB`);
    return contextContents.join('\n\n');
  } catch (error) {
    console.error('Error loading context files:', error);
    return '';
  }
}

// NEW: Targeted lookup for municode queries
// Only loads municode when user specifically asks about building codes
export async function loadMunicodeContext(query: string): Promise<string> {
  // Only load if query mentions Title 22, Title 26, building code, zoning code, etc.
  const needsMunicode = /\b(title\s*(22|26)|building\s*code|zoning\s*code|municode|ordinance|appendix\s*a)\b/i.test(query);
  
  if (!needsMunicode) {
    return '';
  }
  
  try {
    const municodePath = path.join(process.cwd(), 'context', 'municode_title_26.txt');
    if (!fs.existsSync(municodePath)) {
      return '';
    }
    
    const content = fs.readFileSync(municodePath, 'utf8');
    
    // For now, return a truncated version - ideally you'd implement search/RAG here
    // Return first 20K chars (~5K tokens) as a reasonable subset
    const truncated = content.slice(0, 20000);
    console.log(`[contextLoader] Loaded municode (truncated to ${(truncated.length / 1024).toFixed(1)} KB)`);
    
    return `\n\n=== LA COUNTY BUILDING CODE REFERENCE (partial) ===\n${truncated}\n[Note: Showing excerpt. For complete code, see municode.com]`;
  } catch (error) {
    console.error('Error loading municode:', error);
    return '';
  }
}
