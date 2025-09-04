export function normalizeScrapedToMenuData(scraped: any) {
  console.log('normalizeScrapedToMenuData: starting normalization...');
  if (!scraped) {
    console.log('normalizeScrapedToMenuData: no scraped data provided, returning null');
    return null;
  }
  
  console.log('normalizeScrapedToMenuData: checking data structure...');
  if (scraped.store && Array.isArray(scraped.categories)) {
    console.log(`normalizeScrapedToMenuData: processing ${scraped.categories.length} categories`);
    
    const normalized = {
      store: {
        name: scraped.store.name || "Restaurant",
      },
      categories: scraped.categories.map((c: any, idx: number) => {
        console.log(`normalizeScrapedToMenuData: processing category ${idx + 1}: ${c.title || c.name || 'unnamed'}`);
        const itemCount = c.items?.length || 0;
        console.log(`normalizeScrapedToMenuData: category has ${itemCount} items`);
        
        return {
          id: String(c.id || c.name || idx),
          title: c.title || c.name || "Category",
          items: (c.items || []).map((it: any, j: number) => {
            const hasModifiers = (it.detail_raw?.data?.modifierGroups?.length || 0) > 0
              || (it.detail_raw?.data?.customizationsList?.length || 0) > 0;
            console.log(`normalizeScrapedToMenuData: item ${j + 1} "${it.title || it.name || 'unnamed'}" has modifiers: ${hasModifiers}`);

            // Normalize price to dollars
            let normalizedPrice: { amount: number; currency_code: string } | undefined = undefined;
            if (typeof it.price_card === 'string') {
              const dollars = parseFloat(String(it.price_card).replace(/[^0-9.]/g, ""));
              if (Number.isFinite(dollars)) normalizedPrice = { amount: dollars, currency_code: 'USD' };
            } else if (typeof it.price === 'number') {
              normalizedPrice = { amount: it.price, currency_code: 'USD' };
            } else if (it.price && typeof it.price.amount === 'number') {
              normalizedPrice = { amount: it.price.amount, currency_code: it.price.currency_code || 'USD' };
            }

            const rawGroups = it.detail_raw?.data?.customizationsList || it.detail_raw?.data?.modifierGroups || [];
            const modifier_groups = Array.isArray(rawGroups)
              ? rawGroups.map((g: any) => {
                  const options = g.options || g.modifiers || [];
                  return {
                    id: String(g.uuid || g.id || g.title || Math.random()),
                    title: g.title || g.name || 'Options',
                    min_required: Number(g.minPermitted ?? g.minRequired ?? g.min ?? 0),
                    max_allowed: Number(g.maxPermitted ?? g.maxAllowed ?? g.max ?? (options?.length || 0)),
                    modifiers: (options || []).map((m: any) => {
                      const rawPrice = typeof m.priceCents === 'number' ? m.priceCents : (typeof m.price === 'number' ? m.price : null);
                      const dollars = typeof rawPrice === 'number' ? rawPrice / 100 : undefined;
                      return {
                        id: String(m.uuid || m.id || m.title || Math.random()),
                        title: m.title || m.name || '',
                        price: typeof dollars === 'number' ? { amount: dollars, currency_code: 'USD' } : undefined,
                      };
                    })
                  };
                })
              : undefined;

            return {
              id: String(it.id || it.item_uuid || `${idx}-${j}`),
              title: it.title || it.name || '',
              description: it.description || it.description_card || '',
              price: normalizedPrice,
              image_url: it.image_url || it.image_card,
              modifier_groups,
              detail_raw: it.detail_raw || null,
            };
          }),
        };
      }),
    };
    
    console.log('normalizeScrapedToMenuData: normalization completed successfully');
    return normalized;
  }
  
  console.log('normalizeScrapedToMenuData: invalid data structure, returning original data');
  return scraped;
}


