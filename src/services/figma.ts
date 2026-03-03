const FIGMA_API_BASE = 'https://api.figma.com/v1';

export class FigmaService {
  constructor(private accessToken: string) {}

  /** Find a frame/page by name in a Figma file. Returns the node ID or null. */
  async findNodeByName(fileKey: string, name: string): Promise<string | null> {
    const response = await fetch(`${FIGMA_API_BASE}/files/${fileKey}`, {
      headers: { 'X-Figma-Token': this.accessToken },
    });

    if (!response.ok) {
      throw new Error(`Figma API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      document: { children: FigmaNode[] };
    };

    // Search top-level pages and their direct children for the named frame
    for (const page of data.document.children) {
      if (page.name === name) return page.id;
      if (page.children) {
        for (const child of page.children) {
          if (child.name === name) return child.id;
        }
      }
    }

    return null;
  }

  /** Export a specific node from a Figma file as PNG. Returns the image as a Buffer. */
  async exportNodeAsPng(fileKey: string, nodeId: string): Promise<Buffer> {
    const params = new URLSearchParams({
      ids: nodeId,
      format: 'png',
      scale: '2',
    });

    const response = await fetch(
      `${FIGMA_API_BASE}/images/${fileKey}?${params}`,
      { headers: { 'X-Figma-Token': this.accessToken } }
    );

    if (!response.ok) {
      throw new Error(`Figma export error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      images: Record<string, string | null>;
    };

    const imageUrl = Object.values(data.images)[0];
    if (!imageUrl) {
      throw new Error('Figma export returned no image URL');
    }

    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download Figma image: ${imageResponse.status}`);
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
}
