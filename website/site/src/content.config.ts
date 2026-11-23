// The blog posts: Markdown files in src/content/blog/. The file name is the address (/blog/<name>, /ja/blog/<name>).
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lang: z.enum(['ja', 'en']),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
