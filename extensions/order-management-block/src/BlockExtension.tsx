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

  // Отримуємо ID замовлення з контексту
  const orderId = data.order.id;

  useEffect(() => {
    async function fetchProductInventory() {
      if (!data.order.lineItems || data.order.lineItems.length === 0) {
        setIsLoading(false);
        return;
      }

      // Формуємо GraphQL запит для отримання інформації про залишки товарів
      const productVariantIds = data.order.lineItems.map((item: any) => item.variant.id);
      const res = await query<any>(`
        query GetInventoryLevels($variantIds: [ID!]!) {
          productVariants(ids: $variantIds) {
            edges {
              node {
                id
                displayName
                inventoryQuantity
                inventoryItem {
                  id
                }
              }
            }
          }
        }
      `, { variables: { variantIds: productVariantIds } });

      if (res.data?.productVariants?.edges) {
        setProducts(res.data.productVariants.edges.map((edge: any) => edge.node));
      }
      setIsLoading(false);
    }

    fetchProductInventory();
  }, [data.order.lineItems, query]);

  const handleProcessOrder = async () => {
    setIsProcessing(true);

    // 1. Додаємо тег до замовлення
    const addTagsRes = await query(`
      mutation addTags($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }
    `, { variables: { id: orderId, tags: ['Списано зі складу'] } });

    // Якщо були помилки — припиняємо обробку
    if (addTagsRes?.data?.tagsAdd?.userErrors?.length) {
      setIsProcessing(false);
      return;
    }

    // 2. Списуємо товари зі складу
    const inventoryAdjustments = data.order.lineItems
      .map((item: any) => {
        const variant = products.find((p: any) => p.id === item.variant.id);
        if (!variant?.inventoryItem?.id) {
          return null;
        }
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

    // Отримуємо ID локації. Для простоти беремо першу доступну.
    const locationsRes = await query<any>(`{
        locations(first: 1) {
          edges {
            node {
              id
            }
          }
        }
      }`);
    const locationId = locationsRes?.data?.locations?.edges?.[0]?.node?.id;

    if (!locationId) {
      setIsProcessing(false);
      return;
    }

    await query(`
      mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          userErrors {
            field
            message
          }
        }
      }
    `, { variables: {
        input: {
          reason: "fulfillment",
          name: "web",
          changes: inventoryAdjustments,
          locationId: locationId
        }
    }});

    setIsProcessing(false);
    // Оновлюємо сторінку для відображення змін
    window.location.reload();
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
        <Text fontWeight="bold">Залишки товарів на складі:</Text>
        {products.map((product: any) => (
          <InlineStack key={product.id} blockAlign="center">
            <Text>{product.displayName} - </Text>
            <Text fontWeight="bold">{product.inventoryQuantity} шт.</Text>
          </InlineStack>
        ))}

        <Button
          onPress={handleProcessOrder}
          disabled={isProcessing}
        >
          {isProcessing ? <Spinner /> : 'Додати тег та списати зі складу'}
        </Button>
      </BlockStack>
    </AdminBlock>
  );
}