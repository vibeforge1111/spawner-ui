import path from 'node:path';

export function publicSkillSourcePath(filePath: string, sourceRoot?: string | null): string {
	const candidate = sourceRoot ? path.relative(sourceRoot, filePath) : path.basename(filePath);
	if (!candidate || path.isAbsolute(candidate) || candidate === '..' || candidate.startsWith(`..${path.sep}`)) {
		return path.basename(filePath);
	}
	return candidate.split(path.sep).join('/');
}
