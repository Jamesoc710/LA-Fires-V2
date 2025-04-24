import fs from 'fs';
import path from 'path';

export async function loadContext(): Promise<string> {
  try {
    const contextPath = path.join(process.cwd(), 'context', 'municode_title_26.txt');
    const contextData = fs.readFileSync(contextPath, 'utf8');
    return contextData;
  } catch (error) {
    console.error('Error loading context:', error);
    return 'Unable to load context information.';
  }
}

// This function could be expanded to load multiple context files
export async function loadAllContextFiles(): Promise<string> {
  try {
    const contextDir = path.join(process.cwd(), 'context');
    const files = fs.readdirSync(contextDir);
    
    const contextContents = await Promise.all(
      files
        .filter(file => file.endsWith('.txt'))
        .map(file => fs.readFileSync(path.join(contextDir, file), 'utf8'))
    );
    
    return contextContents.join('\n\n');
  } catch (error) {
    console.error('Error loading context files:', error);
    return 'Unable to load context information.';
  }
} 