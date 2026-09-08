import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn style class merge: conditional classes in, conflicts resolved.
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
