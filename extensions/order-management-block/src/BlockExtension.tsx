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

function App() {
  const { data, query } = useApi(TARGET);
  const [products, setProducts] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Якщо дані ще не готові — показуємо лоадер
  if (!data?.order) {
    return (
      <AdminBlock title="Керування складом">
        <Spinner />
      </AdminBlock>
    );
  }

  // Отримуємо ID замовлення з контексту
  const orderId = data.order.id;

  useEffect(() => {
    async function fetchProductInventory() {
      try {
        if (!data.order.lineItems || data.order.lineItems.length === 0) {
          setIsLoading(false);
          return;
        }

        // 1) Отримуємо локацію (беремо першу доступну)
        const locationsRes = await query<any>(`{
          locations(first: 1) {
            edges { node { id } }
          }
        }`);
        const locationId = locationsRes?.data?.locations?.edges?.[0]?.node?.id;

        // 2) Отримуємо залишки для варіантів замовлення
        const productVariantIds = data.order.lineItems.map((item: any) => item.variant.id);
        const res = await query<any>(`
          query GetInventoryLevels($variantIds: [ID!]!, $locationId: ID) {
            nodes(ids: $variantIds) {
              ... on ProductVariant {
                id
                displayName
                inventoryItem {
                  id
                  inventoryLevels(first: 1, locationId: $locationId) {
                    edges { node { available } }
                  }
                }
              }
            }
          }
        `, { variables: { variantIds: productVariantIds, locationId } });

        if (res.data?.nodes) {
          const normalized = res.data.nodes
            .filter((n: any) => n)
            .map((n: any) => ({
              id: n.id,
              displayName: n.displayName,
              inventoryItem: {
                id: n.inventoryItem?.id,
              },
              inventoryQuantity: n.inventoryItem?.inventoryLevels?.edges?.[0]?.node?.available ?? undefined,
            }));
          setProducts(normalized);
        }
      } catch (e: any) {
        setErrorMessage('Не вдалося завантажити дані. Перезавантажте сторінку або перевірте доступи застосунку.');
      } finally {
        setIsLoading(false);
      }
    }

    fetchProductInventory();
  }, [data.order.lineItems, query]);

  const handleProcessOrder = async () => {
    setIsProcessing(true);
    setErrorMessage(null);

    try {
      // 1. Додаємо тег до замовлення
      const addTagsRes = await query(`
        mutation addTags($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            userErrors { field message }
          }
        }
      `, { variables: { id: orderId, tags: ['Списано зі складу'] } });

      if (addTagsRes?.data?.tagsAdd?.userErrors?.length) {
        setErrorMessage('Не вдалося додати тег до замовлення.');
        setIsProcessing(false);
        return;
      }

      // 2. Списуємо товари зі складу
      const inventoryAdjustments = data.order.lineItems
        .map((item: any) => {
          const variant = products.find((p: any) => p.id === item.variant.id);
          if (!variant?.inventoryItem?.id) return null;
          return {
            inventoryItemId: variant.inventoryItem.id,
            availableDelta: -item.quantity,
          };
        })
        .filter(Boolean);

      if (inventoryAdjustments.length === 0) {
        setIsProcessing(false);
        return;
      }

      // Локація
      const locationsRes = await query<any>(`{ locations(first: 1) { edges { node { id } } } }`);
      const locationId = locationsRes?.data?.locations?.edges?.[0]?.node?.id;
      if (!locationId) {
        setErrorMessage('Не знайдено жодної локації для списання.');
        setIsProcessing(false);
        return;
      }

      const adjustRes = await query(`
        mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            userErrors { field message }
          }
        }
      `, { variables: {
          input: {
            reason: 'fulfillment',
            name: 'web',
            changes: inventoryAdjustments,
            locationId,
          }
      }});

      if (adjustRes?.data?.inventoryAdjustQuantities?.userErrors?.length) {
        setErrorMessage('Не вдалося списати товари зі складу.');
        setIsProcessing(false);
        return;
      }

      setIsProcessing(false);
      // Оновлюємо сторінку для відображення змін
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
        {errorMessage && <Text appearance="critical">{errorMessage}</Text>}
        <Text emphasis="bold">Залишки товарів на складі:</Text>
        {products.map((product: any) => (
          <InlineStack key={product.id} blockAlign="center">
            <Text>{product.displayName} - </Text>
            <Text emphasis="bold">{product.inventoryQuantity ?? '—'} шт.</Text>
          </InlineStack>
        ))}

        <Button onPress={handleProcessOrder} disabled={isProcessing}>
          {isProcessing ? <Spinner /> : 'Додати тег та списати зі складу'}
        </Button>
      </BlockStack>
    </AdminBlock>
  );
}