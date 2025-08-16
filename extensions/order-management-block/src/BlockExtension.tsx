import {
  reactExtension,
  useApi,
  AdminBlock,
  BlockStack,
  Button,
  Text,
  InlineStack,
  Spinner,
} from '@shopify/ui-extensions-react/admin';
import { useState, useEffect } from 'react';

// Цільова сторінка для рендерингу блоку
const TARGET = 'admin.order-details.block.render';

export default reactExtension(TARGET, () => <App />);

interface BundleComponentInfo {
  id: string;
  displayName: string;
  inventoryQuantity: number | undefined;
  quantityPerBundle: number;
}

interface ProductInfo {
  id: string;
  displayName: string;
  inventoryItem?: { id?: string };
  inventoryQuantity?: number;
  bundleComponents?: BundleComponentInfo[];
}

function App() {
  const { data, query } = useApi();
  const [products, setProducts] = useState<ProductInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const orderId = data?.order?.id;

  useEffect(() => {
    async function fetchProductInventory() {
      try {
        if (!data?.order?.lineItems || data.order.lineItems.length === 0) {
          setIsLoading(false);
          return;
        }

        // Встановлюємо фіксовану локацію
        const locationId = 'gid://shopify/Location/86334243083';

        // Варіанти з замовлення
        const productVariantIds = data.order.lineItems.map((item: any) => item.variant.id);

        // 1) Тягу інформацію про варіанти + метаполе бандлу
        const variantsRes = await query<any>(`
          query GetVariants($variantIds: [ID!]!, $locationId: ID) {
            nodes(ids: $variantIds) {
              ... on ProductVariant {
                id
                displayName
                inventoryItem { id inventoryLevels(first: 1, locationId: $locationId) { edges { node { available } } } }
                metafield(namespace: "bundle", key: "components") { value type }
              }
            }
          }
        `, { variables: { variantIds: productVariantIds, locationId } });

        const variantNodes: ProductInfo[] = (variantsRes?.data?.nodes || [])
          .filter((n: any) => n)
          .map((n: any) => ({
            id: n.id,
            displayName: n.displayName,
            inventoryItem: { id: n.inventoryItem?.id },
            inventoryQuantity: n.inventoryItem?.inventoryLevels?.edges?.[0]?.node?.available ?? undefined,
            // bundleComponents to be filled later if present
          }));

        // 2) Збираємо всі компоненти бандлів із метаполя, якщо воно є
        const variantIdToBundleComponents: Record<string, { componentId: string; quantity: number }[]> = {};
        const allComponentIds: string[] = [];

        (variantsRes?.data?.nodes || []).forEach((n: any) => {
          if (!n?.metafield?.value) return;
          try {
            const parsed = JSON.parse(n.metafield.value);
            // Очікується формат масиву: [{ variantId: string, quantity: number }]
            if (Array.isArray(parsed)) {
              const list = parsed
                .filter((c: any) => typeof c?.variantId === 'string' && typeof c?.quantity === 'number')
                .map((c: any) => ({ componentId: c.variantId, quantity: c.quantity }));
              if (list.length) {
                variantIdToBundleComponents[n.id] = list;
                list.forEach((c) => allComponentIds.push(c.componentId));
              }
            }
          } catch {
            // ignore invalid JSON
          }
        });

        // 3) Якщо є компоненти — тягнемо їх залишки
        let componentInfoById: Record<string, { displayName: string; inventoryQuantity: number | undefined }> = {};
        if (allComponentIds.length) {
          const componentsRes = await query<any>(`
            query GetBundleComponents($componentIds: [ID!]!, $locationId: ID) {
              nodes(ids: $componentIds) {
                ... on ProductVariant {
                  id
                  displayName
                  inventoryItem { inventoryLevels(first: 1, locationId: $locationId) { edges { node { available } } } }
                }
              }
            }
          `, { variables: { componentIds: allComponentIds, locationId } });

          (componentsRes?.data?.nodes || []).forEach((node: any) => {
            if (!node) return;
            componentInfoById[node.id] = {
              displayName: node.displayName,
              inventoryQuantity: node.inventoryItem?.inventoryLevels?.edges?.[0]?.node?.available ?? undefined,
            };
          });
        }

        // 4) Збираємо фінальну структуру з компонентами бандлів
        const withBundles = variantNodes.map((v) => {
          const bundle = variantIdToBundleComponents[v.id];
          if (!bundle) return v;
          const bundleComponents: BundleComponentInfo[] = bundle.map((c) => ({
            id: c.componentId,
            displayName: componentInfoById[c.componentId]?.displayName || c.componentId,
            inventoryQuantity: componentInfoById[c.componentId]?.inventoryQuantity,
            quantityPerBundle: c.quantity,
          }));
          return { ...v, bundleComponents };
        });

        setProducts(withBundles);
      } catch (e: any) {
        setErrorMessage('Не вдалося завантажити дані. Перезавантажте сторінку або перевірте доступи застосунку.');
      } finally {
        setIsLoading(false);
      }
    }

    fetchProductInventory();
  }, [data?.order?.lineItems, query]);

  const handleProcessOrder = async () => {
    setIsProcessing(true);
    setErrorMessage(null);

    if (!orderId) {
      setErrorMessage('Відсутній ідентифікатор замовлення.');
      setIsProcessing(false);
      return;
    }

    try {
      const addTagsRes = await query(`
        mutation addTags($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
        }
      `, { variables: { id: orderId, tags: ['Списано зі складу'] } });

      if (addTagsRes?.data?.tagsAdd?.userErrors?.length) {
        setErrorMessage('Не вдалося додати тег до замовлення.');
        setIsProcessing(false);
        return;
      }

      const inventoryAdjustments = (data.order.lineItems as any[])
        .map((item: any) => {
          const variant = products.find((p: any) => p.id === item.variant.id);
          if (!variant?.inventoryItem?.id) return null;
          return { inventoryItemId: variant.inventoryItem.id, availableDelta: -item.quantity };
        })
        .filter(Boolean) as { inventoryItemId: string; availableDelta: number }[];

      if (inventoryAdjustments.length === 0) {
        setIsProcessing(false);
        return;
      }

      const locationId = 'gid://shopify/Location/86334243083';

      const adjustRes = await query(`
        mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) { userErrors { field message } }
        }
      `, { variables: { input: { reason: 'fulfillment', name: 'web', changes: inventoryAdjustments, locationId } } });

      if (adjustRes?.data?.inventoryAdjustQuantities?.userErrors?.length) {
        setErrorMessage('Не вдалося списати товари зі складу.');
        setIsProcessing(false);
        return;
      }

      setIsProcessing(false);
      // eslint-disable-next-line no-restricted-globals
      location.reload();
    } catch (e: any) {
      setIsProcessing(false);
      setErrorMessage('Сталася помилка під час обробки замовлення.');
    }
  };

  if (isLoading) {
    return (
      <AdminBlock title="Керування складом">
        <Spinner />
      </AdminBlock>
    );
  }

  return (
    <AdminBlock title="Керування складом">
      <BlockStack>
        {errorMessage ? <Text>{errorMessage}</Text> : null}
        <Text>Залишки товарів на складі:</Text>
        {products.map((product) => (
          <BlockStack key={product.id}>
            <InlineStack>
              <Text>{product.displayName} - </Text>
              <Text>{product.inventoryQuantity ?? '—'} шт.</Text>
            </InlineStack>
            {product.bundleComponents && product.bundleComponents.length > 0 ? (
              <BlockStack>
                <Text>Склад бандлу:</Text>
                {product.bundleComponents.map((comp) => (
                  <InlineStack key={comp.id}>
                    <Text>• {comp.displayName} × {comp.quantityPerBundle} — </Text>
                    <Text>{comp.inventoryQuantity ?? '—'} шт. на складі</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            ) : null}
          </BlockStack>
        ))}

        <Button onPress={handleProcessOrder} disabled={isProcessing}>
          {isProcessing ? <Spinner /> : 'Додати тег та списати зі складу'}
        </Button>
      </BlockStack>
    </AdminBlock>
  );
}