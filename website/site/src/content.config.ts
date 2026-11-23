// The blog posts: Markdown files in src/content/blog/<lang>/. The file name is the address (/blog/<name>, /ja/blog/<name>),
// so the two languages of one post share a name and the language menu can switch between them.
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({ pattern: '*/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lang: z.enum(['ja', 'en']),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
