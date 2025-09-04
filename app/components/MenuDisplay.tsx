'use client';

import { useState } from 'react';

interface MenuItem {
  id: string;
  title: string;
  description?: string;
  price?: {
    amount: number;
    currency_code: string;
  };
  image_url?: string;
  modifier_groups?: ModifierGroup[];
  detail_raw?: any;
}

interface ModifierGroup {
  id: string;
  title: string;
  min_required: number;
  max_allowed: number;
  modifiers: Modifier[];
}

interface Modifier {
  id: string;
  title: string;
  price?: {
    amount: number;
    currency_code: string;
  };
}

interface MenuCategory {
  id: string;
  title: string;
  subtitle?: string;
  items: MenuItem[];
}

interface MenuData {
  categories: MenuCategory[];
  store: {
    name: string;
    description?: string;
    image_url?: string;
  };
}

interface MenuDisplayProps {
  menuData: MenuData;
}

export default function MenuDisplay({ menuData }: MenuDisplayProps) {
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(
    new Set(menuData.categories.map(cat => cat.id))
  );
  const [activeItem, setActiveItem] = useState<MenuItem | null>(null);

  const toggleCategory = (categoryId: string) => {
    setCollapsedCategories(prev => {
      const newSet = new Set(prev);
      if (newSet.has(categoryId)) {
        newSet.delete(categoryId);
      } else {
        newSet.add(categoryId);
      }
      return newSet;
    });
  };

  const formatPrice = (price?: { amount: number; currency_code: string }) => {
    if (!price) return '';
    return `$${(price.amount).toFixed(2)}`;
  };

  // Debug: Log the data to check for duplicates
  console.log('Menu data:', menuData);
  console.log('Categories count:', menuData.categories.length);
  console.log('Categories:', menuData.categories.map(c => ({ id: c.id, title: c.title, itemCount: c.items.length })));

  return (
    <div className="max-w-6xl mx-auto p-4">
      {/* Restaurant Header - More Compact */}
      <div className="mb-6 text-center">
        {menuData.store.image_url && (
          <img
            src={menuData.store.image_url}
            alt={menuData.store.name}
            className="w-24 h-24 mx-auto rounded-full object-cover mb-3 shadow-lg"
          />
        )}
        <h1 className="text-3xl font-bold text-gray-800 mb-2">
          {menuData.store.name}
        </h1>
        {menuData.store.description && (
          <p className="text-gray-600">{menuData.store.description}</p>
        )}
      </div>

      {/* Menu Categories - Compact Grid Layout */}
      <div className="grid gap-4">
        {menuData.categories.map((category, index) => {
          const isCollapsed = collapsedCategories.has(category.id);
          
          return (
            <div key={`${category.id}-${index}`} className="bg-white rounded-lg shadow-sm border border-gray-200">
              <button
                onClick={() => toggleCategory(category.id)}
                className="w-full text-left p-4 flex items-center justify-between hover:bg-gray-50 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded">
                    {index + 1}
                  </span>
                  <div>
                    <h2 className="text-xl font-semibold text-gray-800">
                      {category.title}
                    </h2>
                    {category.subtitle && (
                      <p className="text-gray-600 text-sm">{category.subtitle}</p>
                    )}
                    <span className="text-xs text-gray-500">
                      {category.items.length} items
                    </span>
                  </div>
                </div>
                <svg
                  className={`w-5 h-5 text-gray-500 transition-transform ${
                    isCollapsed ? 'rotate-180' : ''
                  }`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>

              {!isCollapsed && (
                <div className="px-4 pb-4">
                  {/* Compact Item Grid */}
                  <div className="grid gap-3">
                    {category.items.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-start gap-3 p-3 border border-gray-100 rounded-md hover:bg-gray-50 transition-colors cursor-pointer"
                        onClick={() => setActiveItem(item)}
                      >
                        {item.image_url && (
                          <img
                            src={item.image_url}
                            alt={item.title}
                            className="w-16 h-16 rounded-md object-cover flex-shrink-0"
                          />
                        )}
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-start gap-2 mb-1">
                            <h3 className="text-base font-medium text-gray-800 truncate">
                              {item.title}
                            </h3>
                            {item.price && (
                              <span className="text-base font-semibold text-green-600 flex-shrink-0">
                                {formatPrice(item.price)}
                              </span>
                            )}
                          </div>
                          
                          {item.description && (
                            <p className="text-gray-600 text-sm mb-2 line-clamp-2">
                              {item.description}
                            </p>
                          )}

                          {/* Compact Modifier Groups */}
                          {item.modifier_groups && item.modifier_groups.length > 0 && (
                            <div className="space-y-1">
                              {item.modifier_groups.map((group) => (
                                <div key={group.id} className="text-xs">
                                  <span className="font-medium text-gray-700">
                                    {group.title}
                                  </span>
                                  {group.min_required > 0 && (
                                    <span className="text-gray-500 ml-1">
                                      (Required: {group.min_required})
                                    </span>
                                  )}
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {group.modifiers.slice(0, 3).map((modifier) => (
                                      <span
                                        key={modifier.id}
                                        className="bg-gray-100 px-2 py-1 rounded text-gray-600 text-xs"
                                      >
                                        {modifier.title}
                                        {modifier.price && ` +${formatPrice(modifier.price)}`}
                                      </span>
                                    ))}
                                    {group.modifiers.length > 3 && (
                                      <span className="text-gray-500 text-xs">
                                        +{group.modifiers.length - 3} more
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Item Detail Modal */}
      {activeItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setActiveItem(null)} />
          <div className="relative z-10 w-full max-w-2xl mx-4 bg-white rounded-lg shadow-xl border border-gray-200">
            <div className="flex items-start justify-between p-4 border-b">
              <div>
                <h3 className="text-xl font-semibold text-gray-800">{activeItem.title}</h3>
                {activeItem.price && (
                  <div className="text-green-600 font-semibold">{formatPrice(activeItem.price)}</div>
                )}
              </div>
              <button
                className="p-2 text-gray-500 hover:text-gray-700 cursor-pointer"
                onClick={() => setActiveItem(null)}
                aria-label="Close"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-4 space-y-4 max-h-[70vh] overflow-auto">
              {activeItem.image_url && (
                <img src={activeItem.image_url} alt={activeItem.title} className="w-full h-56 object-cover rounded" />
              )}
              {activeItem.description && (
                <p className="text-gray-700 text-sm">{activeItem.description}</p>
              )}

              {/* Render normalized modifier groups if present */}
              {activeItem.modifier_groups && activeItem.modifier_groups.length > 0 && (
                <div className="space-y-4">
                  {activeItem.modifier_groups.map(group => (
                    <div key={group.id}>
                      <div className="text-sm font-medium text-gray-800">
                        {group.title}
                        {(group.min_required > 0 || group.max_allowed > 0) && (
                          <span className="text-gray-500 font-normal ml-1">
                            ({group.min_required > 0 ? `min ${group.min_required}` : ''}{group.min_required > 0 && group.max_allowed > 0 ? ', ' : ''}{group.max_allowed > 0 ? `max ${group.max_allowed}` : ''})
                          </span>
                        )}
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        {group.modifiers.map(mod => (
                          <div key={mod.id} className="text-xs bg-gray-50 border border-gray-200 rounded p-2 flex justify-between items-center">
                            <span className="text-gray-700">{mod.title}</span>
                            {mod.price && <span className="text-gray-600 ml-2">+{formatPrice(mod.price)}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Fallback: render detail_raw customizations if modifier_groups not normalized */}
              {!activeItem.modifier_groups?.length && activeItem.detail_raw?.data?.customizationsList && (
                <div className="space-y-4">
                  {activeItem.detail_raw.data.customizationsList.map((g: any) => (
                    <div key={g.uuid || g.title}>
                      <div className="text-sm font-medium text-gray-800">
                        {g.title}
                        {(g.minPermitted > 0 || g.maxPermitted > 0) && (
                          <span className="text-gray-500 font-normal ml-1">
                            ({g.minPermitted ? `min ${g.minPermitted}` : ''}{g.minPermitted && g.maxPermitted ? ', ' : ''}{g.maxPermitted ? `max ${g.maxPermitted}` : ''})
                          </span>
                        )}
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        {(g.options || []).map((opt: any) => (
                          <div key={opt.uuid || opt.title} className="text-xs bg-gray-50 border border-gray-200 rounded p-2 flex justify-between items-center">
                            <span className="text-gray-700">{opt.title}</span>
                            {typeof opt.price === 'number' && (
                              <span className="text-gray-600 ml-2">+${(opt.price / 100).toFixed(2)}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="p-4 border-t flex justify-end">
              <button className="px-4 py-2 text-sm bg-gray-800 text-white rounded cursor-pointer" onClick={() => setActiveItem(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
