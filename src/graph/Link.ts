export type ResolvedLinkCache = Record<string, Record<string, number>>;

export default class Link {
	public readonly source: string;
	public readonly target: string;
	public readonly linksAnAttachment: boolean;

	constructor(sourceId: string, targetId: string, linksAnAttachment: boolean) {
		this.source = sourceId;
		this.target = targetId;
		this.linksAnAttachment = linksAnAttachment;
	}

	// Creates a link index for an array of links
	static createLinkIndex(links: Link[]): Map<string, Map<string, number>> {
		const linkIndex = new Map<string, Map<string, number>>();
		links.forEach((link, index) => {
			if (!linkIndex.has(link.source)) {
				linkIndex.set(link.source, new Map<string, number>());
			}
			linkIndex.get(link.source)?.set(link.target, index);
		});

		return linkIndex;
	}
}
